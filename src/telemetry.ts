import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  HISTORY_LIMIT,
  HISTORY_MS,
  HISTORY_WINDOWS,
  historyGraph,
  isHistoryPoint,
  roundMetric,
  type HistoryPoint,
  type HistorySummary,
  type MetricSummary,
} from './history.js';
import { HistoryFileStore, type HistoryStorageStatus } from './storage.js';

export type CommandOutcome = 'ok' | 'denied' | 'cooldown' | 'failed' | 'interrupted';
export interface CommandAudit {
  id: string;
  command: string;
  actorId: string;
  guildId: string;
  channelId: string | null;
  startedAt: number;
  finishedAt: number | null;
  outcome: CommandOutcome | 'started';
  durationMs: number | null;
}
export interface HistoryComparison {
  current: HistorySummary;
  previous: HistorySummary;
}
type RecoveryLogger = (event: string) => void;

function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}
function quarantine(path: string): void {
  const suffix = `.corrupt-${Date.now()}-${randomUUID()}`;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    if (!lstatSync(file).isFile()) throw namedError('UnsafeTelemetryPath');
    renameSync(file, `${file}${suffix}`);
    chmodSync(`${file}${suffix}`, 0o600);
  }
}
function isCorrupt(error: unknown): boolean {
  const e = error as { name?: string; errcode?: number };
  return e.name === 'CorruptTelemetryDatabase' || e.errcode === 11 || e.errcode === 26;
}

/** The database keeps all samples; only the recent read cache and retry buffer are bounded. */
export class TelemetryStore {
  private readonly db: DatabaseSync;
  private pending = new Map<number, HistoryPoint>();
  private metricsHealthy = true;
  private auditHealthy = true;
  private auditFailures = 0;
  private metricCount = 0;
  private commandCount = 0;
  private lastSavedAt: number | null = null;
  private closed = false;
  private droppedSamples = 0;

  private constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) {
        if (!lstatSync(path).isFile()) throw namedError('UnsafeTelemetryPath');
      } else closeSync(openSync(path, 'ax', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path, { timeout: 250, defensive: true, allowExtension: false });
    try {
      const check = this.db.prepare('PRAGMA quick_check').get();
      if (!check || Object.values(check)[0] !== 'ok') throw namedError('CorruptTelemetryDatabase');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version !== 0 && version !== 1) throw namedError('UnsupportedTelemetrySchema');
      if (
        version === 0 &&
        Number(
          this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get()?.n,
        )
      ) {
        throw namedError('UnsupportedTelemetrySchema');
      }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        PRAGMA cache_size=-4096; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=1048576;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS metrics (
          at INTEGER PRIMARY KEY CHECK(at >= 0 AND at <= 8640000000000000),
          cpu REAL CHECK(cpu BETWEEN 0 AND 100), memory REAL CHECK(memory BETWEEN 0 AND 100),
          temperature REAL CHECK(temperature BETWEEN -30 AND 150)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS commands (
          id TEXT PRIMARY KEY, command TEXT NOT NULL, actorId TEXT NOT NULL,
          guildId TEXT NOT NULL, channelId TEXT, startedAt INTEGER NOT NULL,
          finishedAt INTEGER, outcome TEXT NOT NULL, durationMs INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS commands_time ON commands(startedAt DESC);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        PRAGMA user_version=1; COMMIT;`);
      this.db.prepare("UPDATE commands SET outcome='interrupted' WHERE outcome='started'").run();
      this.metricCount = Number(this.db.prepare('SELECT COUNT(*) AS n FROM metrics').get()?.n);
      this.commandCount = Number(this.db.prepare('SELECT COUNT(*) AS n FROM commands').get()?.n);
      const last = this.db
        .prepare("SELECT value FROM metadata WHERE key='last_saved_at'")
        .get()?.value;
      this.lastSavedAt = last === undefined ? null : Number(last);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  static async open(
    path: string,
    legacyFile?: string,
    onRecovery: RecoveryLogger = () => {},
  ): Promise<TelemetryStore> {
    let store: TelemetryStore;
    try {
      store = new TelemetryStore(path);
    } catch (error) {
      if (path === ':memory:' || !isCorrupt(error)) throw error;
      quarantine(path);
      store = new TelemetryStore(path);
      store.recovered();
      onRecovery('telemetry_database_quarantined');
    }
    try {
      if (
        legacyFile &&
        !store.db.prepare("SELECT value FROM metadata WHERE key='legacy_imported'").get()
      ) {
        let points: HistoryPoint[] = [];
        const source = existsSync(legacyFile) ? legacyFile : `${legacyFile}.migrated`;
        if (existsSync(source)) {
          try {
            points = await new HistoryFileStore(source).load();
          } catch (error) {
            if ((error as Error).name !== 'InvalidHistoryFile') throw error;
            quarantine(source);
            store.recovered();
            onRecovery('legacy_history_quarantined');
          }
        }
        store.importLegacy(points);
      }
      // This is deliberately outside the import transaction and is safe to retry after a crash.
      if (legacyFile && existsSync(legacyFile) && !existsSync(`${legacyFile}.migrated`)) {
        try {
          renameSync(legacyFile, `${legacyFile}.migrated`);
        } catch {
          onRecovery('legacy_history_copy_kept');
        }
      }
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  private recovered(): void {
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES('recoveries','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
      )
      .run();
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private importLegacy(points: readonly HistoryPoint[]): void {
    let inserted = 0;
    const savedAt = points.length ? Date.now() : null;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO metrics(at,cpu,memory,temperature) VALUES(?,?,?,?)',
    );
    // Rows and the import marker commit together. Timestamp primary keys also make retries safe.
    this.transaction(() => {
      for (const p of points) {
        inserted += Number(
          insert.run(p.at, roundMetric(p.cpu), roundMetric(p.memory), roundMetric(p.temperature))
            .changes,
        );
      }
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('legacy_imported','1')").run();
      if (savedAt !== null)
        this.db
          .prepare(
            "INSERT INTO metadata(key,value) VALUES('last_saved_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(String(savedAt));
    });
    this.metricCount += inserted;
    if (savedAt !== null) this.lastSavedAt = savedAt;
  }

  recordMetrics(points: readonly HistoryPoint[]): void {
    for (const point of points) {
      if (!isHistoryPoint(point)) throw namedError('InvalidMetricSample');
      this.pending.set(point.at, {
        at: point.at,
        cpu: roundMetric(point.cpu),
        memory: roundMetric(point.memory),
        temperature: roundMetric(point.temperature),
      });
      if (this.pending.size >= HISTORY_LIMIT) this.flush();
    }
    // A disk failure must not turn an indefinite archive into an unbounded RAM queue.
    this.flush();
  }

  flush(): void {
    if (!this.pending.size) return;
    let inserted = 0;
    try {
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO metrics(at,cpu,memory,temperature) VALUES(?,?,?,?)',
      );
      this.transaction(() => {
        for (const p of this.pending.values())
          inserted += Number(insert.run(p.at, p.cpu, p.memory, p.temperature).changes);
        this.db
          .prepare(
            "INSERT INTO metadata(key,value) VALUES('last_saved_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(String(Date.now()));
      });
      this.metricCount += inserted;
      this.pending.clear();
      this.metricsHealthy = true;
      this.lastSavedAt = Date.now();
    } catch (error) {
      this.metricsHealthy = false;
      while (this.pending.size > HISTORY_LIMIT) {
        this.pending.delete(this.pending.keys().next().value!);
        this.droppedSamples++;
      }
      throw error;
    }
  }

  recent(now = Date.now()): HistoryPoint[] {
    return this.db
      .prepare(
        'SELECT at,cpu,memory,temperature FROM metrics WHERE at>=? AND at<=? ORDER BY at DESC LIMIT ?',
      )
      .all(now - HISTORY_MS, now, HISTORY_LIMIT)
      .reverse() as unknown as HistoryPoint[];
  }

  summary(minutes: number, now = Date.now()): HistorySummary {
    return this.range(minutes, now - minutes * 60_000, now + 1);
  }

  compare(minutes: number, now = Date.now()): HistoryComparison {
    const from = now - minutes * 60_000;
    return {
      current: this.range(minutes, from, now + 1),
      previous: this.range(minutes, from - minutes * 60_000, from),
    };
  }

  private range(minutes: number, from: number, to: number): HistorySummary {
    if (!(HISTORY_WINDOWS as readonly number[]).includes(minutes))
      throw namedError('UnsupportedHistoryWindow');
    const columns = ['cpu', 'memory', 'temperature'] as const;
    const aggregates = columns
      .map(
        (column) =>
          `COUNT(${column}) AS ${column}Count, MIN(${column}) AS ${column}Min, AVG(${column}) AS ${column}Mean, MAX(${column}) AS ${column}Max`,
      )
      .join(',');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(at) AS firstAt, MAX(at) AS lastAt, ${aggregates} FROM metrics WHERE at>=? AND at<?`,
      )
      .get(from, to)!;
    // Indexed ranges avoid a GROUP BY sort that could spill a year of data into /tmp.
    const bucketQuery = this.db.prepare(
      'SELECT AVG(cpu) AS cpu, AVG(memory) AS memory, AVG(temperature) AS temperature FROM metrics WHERE at>=? AND at<?',
    );
    const bins = Array.from({ length: 24 }, (_, bucket) => {
      const values = bucketQuery.get(
        Math.ceil(from + ((to - from) * bucket) / 24),
        Math.ceil(from + ((to - from) * (bucket + 1)) / 24),
      )!;
      return { bucket, cpu: values.cpu, memory: values.memory, temperature: values.temperature };
    });
    const metric = (column: (typeof columns)[number]): MetricSummary | null => {
      const count = Number(row[`${column}Count`]);
      if (!count) return null;
      const buckets: (number | null)[] = Array(24).fill(null);
      for (const bin of bins)
        buckets[Number(bin.bucket)] = bin[column] === null ? null : Number(bin[column]);
      return {
        count,
        min: Number(row[`${column}Min`]),
        mean: Number(row[`${column}Mean`]),
        max: Number(row[`${column}Max`]),
        graph: historyGraph(buckets),
      };
    };
    return {
      minutes,
      count: Number(row.n),
      firstAt: row.firstAt === null ? null : Number(row.firstAt),
      lastAt: row.lastAt === null ? null : Number(row.lastAt),
      cpu: metric('cpu'),
      memory: metric('memory'),
      temperature: metric('temperature'),
    };
  }

  startCommand(entry: Omit<CommandAudit, 'finishedAt' | 'outcome' | 'durationMs'>): void {
    try {
      const result = this.db
        .prepare(
          "INSERT OR IGNORE INTO commands(id,command,actorId,guildId,channelId,startedAt,outcome) VALUES(?,?,?,?,?,?,'started')",
        )
        .run(
          entry.id,
          entry.command,
          entry.actorId,
          entry.guildId,
          entry.channelId,
          entry.startedAt,
        );
      this.commandCount += Number(result.changes);
      this.auditHealthy = true;
    } catch (error) {
      this.auditFailures++;
      this.auditHealthy = false;
      throw error;
    }
  }

  finishCommand(
    id: string,
    outcome: CommandOutcome,
    finishedAt = Date.now(),
    durationMs = 0,
  ): void {
    try {
      const result = this.db
        .prepare(
          "UPDATE commands SET outcome=?,finishedAt=?,durationMs=? WHERE id=? AND outcome='started'",
        )
        .run(outcome, finishedAt, Math.max(0, Math.round(durationMs)), id);
      if (!Number(result.changes) && !this.db.prepare('SELECT id FROM commands WHERE id=?').get(id))
        throw namedError('AuditRecordMissing');
      this.auditHealthy = true;
    } catch (error) {
      this.auditFailures++;
      this.auditHealthy = false;
      throw error;
    }
  }

  recentCommands(limit = 10): CommandAudit[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw namedError('InvalidAuditLimit');
    return this.db
      .prepare('SELECT * FROM commands ORDER BY startedAt DESC,id DESC LIMIT ?')
      .all(limit) as unknown as CommandAudit[];
  }

  status(): HistoryStorageStatus {
    const first = this.db.prepare('SELECT MIN(at) AS at FROM metrics').get()?.at;
    return {
      healthy: this.metricsHealthy && this.auditHealthy,
      lastSavedAt: this.lastSavedAt,
      metricCount: this.metricCount,
      commandCount: this.commandCount,
      firstAt: first === null ? null : Number(first),
      recoveries: Number(
        this.db.prepare("SELECT value FROM metadata WHERE key='recoveries'").get()?.value ?? 0,
      ),
      pendingSamples: this.pending.size,
      auditFailures: this.auditFailures,
      droppedSamples: this.droppedSamples,
    };
  }

  close(): void {
    if (this.closed) return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.db.close();
      this.closed = true;
    }
  }
}

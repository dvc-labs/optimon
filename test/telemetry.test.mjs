import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from '../dist/backup.js';
import { HISTORY_LIMIT, HISTORY_WINDOWS } from '../dist/history.js';
import { HistoryFileStore } from '../dist/storage.js';
import { TelemetryStore } from '../dist/telemetry.js';

const now = Date.now();
const point = (at = now, overrides = {}) => ({
  at,
  cpu: 12.34567,
  memory: 23.45678,
  temperature: 31.23456,
  ...overrides,
});
const command = (id = '1562643787510063218', overrides = {}) => ({
  id,
  command: 'stats',
  actorId: '1562643787510063219',
  guildId: '1562082957022204006',
  channelId: '1562960345860153444',
  startedAt: now,
  ...overrides,
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'optiplex-telemetry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'optiplex.sqlite');
  return { directory, path };
}

test('the archive retains every sample across restarts while the recent RAM input is bounded', async (t) => {
  const { path } = await fixture(t);
  let store = await TelemetryStore.open(path);
  const values = Array.from({ length: HISTORY_LIMIT + 100 }, (_, i) => point(now - i * 60_000));
  values.push(point(now - 400 * 86400_000));
  store.recordMetrics(values);
  store.recordMetrics([values[0]]);
  assert.equal(
    store.status().metricCount,
    values.length,
    'duplicate timestamps must not add another sample',
  );
  store.close();
  store = await TelemetryStore.open(path);
  t.after(() => store.close());
  assert.equal(store.status().metricCount, values.length);
  assert.equal(
    store.status().firstAt,
    now - 400 * 86400_000,
    'even data older than the longest command window stays archived',
  );
  assert.equal(store.recent(now).length, HISTORY_LIMIT);
  const summary = store.summary(10080, now);
  assert.equal(summary.count, values.length - 1);
  assert.equal(summary.cpu.min, 12.3);
  assert.equal(summary.memory.max, 23.5);
  assert.equal(summary.temperature.min, 31.2);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('v0.2.1 migration imports all retained JSON points once, including old readings, and preserves the source', async (t) => {
  const { directory, path } = await fixture(t);
  const legacy = join(directory, 'history.json');
  const file = new HistoryFileStore(legacy);
  await file.load();
  await file.save([point(now - 3 * 86400_000), point()]);
  const original = await readFile(legacy);
  let store = await TelemetryStore.open(path, legacy);
  assert.equal(store.status().metricCount, 2);
  assert.equal(store.recent(now).length, 1);
  assert.equal(store.summary(10080, now).count, 2);
  store.close();
  assert.deepEqual(await readFile(`${legacy}.migrated`), original);
  store = await TelemetryStore.open(path, legacy);
  assert.equal(store.status().metricCount, 2);
  store.close();
});

test('the live connection uses WAL, full synchronous commits and a bounded busy timeout', async () => {
  const store = await TelemetryStore.open(':memory:');
  try {
    assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 250);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
  } finally {
    store.close();
  }
});

test('a second local connection reads committed WAL data while the writer has another transaction open', async (t) => {
  const { path } = await fixture(t);
  const store = await TelemetryStore.open(path);
  const reader = new DatabaseSync(path, { readOnly: true, timeout: 250 });
  t.after(() => {
    reader.close();
    store.close();
  });
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  store.recordMetrics([point()]);
  store.db.exec('BEGIN IMMEDIATE');
  store.db.prepare('INSERT INTO metrics(at,cpu) VALUES(?,?)').run(now + 60_000, 50);
  try {
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 1);
  } finally {
    store.db.exec('ROLLBACK');
  }
});

test('SIGKILL during schema creation or on either side of the import commit leaves migration restartable', async (t) => {
  for (const phase of ['schema', 'before-import-commit', 'after-import-commit']) {
    const { directory, path } = await fixture(t);
    const legacy = join(directory, 'history.json');
    const file = new HistoryFileStore(legacy);
    await file.load();
    await file.save([point(now - 3 * 86400_000), point()]);
    const original = await readFile(legacy);
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { DatabaseSync } from 'node:sqlite';
      import { TelemetryStore } from './dist/telemetry.js';
      const phase = process.argv[3];
      const execute = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if (phase === 'schema' && sql.includes('CREATE TABLE IF NOT EXISTS metrics')) {
          execute.call(this, sql.slice(0, sql.lastIndexOf('COMMIT;')));
          process.kill(process.pid, 'SIGKILL');
        }
        if (sql === 'COMMIT' && phase === 'before-import-commit') process.kill(process.pid, 'SIGKILL');
        const result = execute.call(this, sql);
        if (sql === 'COMMIT' && phase === 'after-import-commit') process.kill(process.pid, 'SIGKILL');
        return result;
      };
      await TelemetryStore.open(process.argv[1], process.argv[2]);
    `,
        path,
        legacy,
        phase,
      ],
      { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(child.signal, 'SIGKILL', `${phase}: ${child.stderr}`);
    const recovered = await TelemetryStore.open(path, legacy);
    assert.equal(
      recovered.status().metricCount,
      2,
      `${phase}: exactly one copy of every imported reading`,
    );
    assert.equal(recovered.status().recoveries, 0, 'an interrupted transaction is not corruption');
    assert.equal(recovered.db.prepare('PRAGMA user_version').get().user_version, 1);
    recovered.close();
    const repeated = await TelemetryStore.open(path, legacy);
    assert.equal(repeated.status().metricCount, 2);
    repeated.close();
    assert.deepEqual(await readFile(`${legacy}.migrated`), original);
  }
});

test('corrupt legacy history is quarantined byte-for-byte and monitoring gets a usable database', async (t) => {
  const { directory, path } = await fixture(t);
  const legacy = join(directory, 'history.json');
  const content = 'corrupted fixture with private contents';
  await writeFile(legacy, content);
  const events = [];
  const store = await TelemetryStore.open(path, legacy, (event) => events.push(event));
  t.after(() => store.close());
  store.recordMetrics([point()]);
  assert.equal(store.status().metricCount, 1);
  assert.equal(store.status().recoveries, 1);
  assert.deepEqual(events, ['legacy_history_quarantined']);
  const quarantined = (await readdir(directory)).find((name) =>
    name.startsWith('history.json.corrupt-'),
  );
  assert.ok(quarantined);
  assert.equal(await readFile(join(directory, quarantined), 'utf8'), content);
  assert.equal((await stat(join(directory, quarantined))).mode & 0o777, 0o600);
});

test('a corrupt SQLite database is preserved separately before a fresh archive is created', async (t) => {
  const { directory, path } = await fixture(t);
  const original = Buffer.from('this is not a SQLite database');
  await writeFile(path, original);
  const events = [];
  const store = await TelemetryStore.open(path, undefined, (event) => events.push(event));
  t.after(() => store.close());
  assert.deepEqual(events, ['telemetry_database_quarantined']);
  assert.equal(store.status().recoveries, 1);
  store.recordMetrics([point()]);
  assert.equal(store.status().metricCount, 1);
  const preserved = (await readdir(directory)).find((name) =>
    name.startsWith('optiplex.sqlite.corrupt-'),
  );
  assert.deepEqual(await readFile(join(directory, preserved)), original);
});

test('unsupported database formats and symbolic links are not overwritten or silently reset', async (t) => {
  const { directory, path } = await fixture(t);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=2; CREATE TABLE future(value TEXT);');
  db.close();
  const original = await readFile(path);
  await assert.rejects(TelemetryStore.open(path), { name: 'UnsupportedTelemetrySchema' });
  assert.deepEqual(await readFile(path), original);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes('.corrupt-')),
    false,
  );
  const linked = join(directory, 'linked.sqlite');
  await symlink(path, linked);
  await assert.rejects(TelemetryStore.open(linked), { name: 'UnsafeTelemetryPath' });
  assert.deepEqual(await readFile(path), original);
});

test('all comparison windows have distinct boundaries, bounded graph buckets and honest missing values', async () => {
  for (const minutes of HISTORY_WINDOWS) {
    const store = await TelemetryStore.open(':memory:');
    try {
      const from = now - minutes * 60_000;
      store.recordMetrics([
        point(from - minutes * 60_000 - 1, { cpu: 99 }),
        point(from - minutes * 60_000, { cpu: 10, memory: null, temperature: null }),
        point(from - 1, { cpu: 20, memory: null, temperature: null }),
        point(from, { cpu: 30, memory: null }),
        point(now, { cpu: 50 }),
        point(now + 1, { cpu: 99 }),
      ]);
      const { current, previous } = store.compare(minutes, now);
      assert.equal(previous.count, 2);
      assert.equal(previous.cpu.mean, 15);
      assert.equal(previous.temperature, null);
      assert.equal(current.count, 2);
      assert.equal(current.cpu.mean, 40);
      assert.equal(current.cpu.graph.length, 24);
      assert.equal(current.cpu.graph[0], '▃');
      assert.equal(current.cpu.graph[23], '▅');
      assert.match(current.cpu.graph, /·/);
      assert.equal(current.memory.count, 1);
      assert.equal(store.summary(minutes, now).count, current.count);
      assert.throws(() => store.summary(42, now), { name: 'UnsupportedHistoryWindow' });
    } finally {
      store.close();
    }
  }
});

test('committed metrics and command starts survive SIGKILL without a shutdown hook', async (t) => {
  const { path } = await fixture(t);
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { TelemetryStore } from './dist/telemetry.js';
    const store = await TelemetryStore.open(process.argv[1]);
    store.recordMetrics(JSON.parse(process.argv[2]));
    store.startCommand(JSON.parse(process.argv[3]));
    process.kill(process.pid, 'SIGKILL');
  `,
      path,
      JSON.stringify([point()]),
      JSON.stringify(command()),
    ],
    {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const store = await TelemetryStore.open(path);
  t.after(() => store.close());
  assert.equal(store.status().metricCount, 1);
  assert.equal(store.status().commandCount, 1);
  const [audit] = store.recentCommands();
  assert.equal(audit.actorId, command().actorId, 'Discord IDs stay strings without precision loss');
  assert.equal(audit.outcome, 'interrupted');
  assert.equal(audit.finishedAt, null, 'a killed command must not look successfully completed');
});

test('audit outcomes, timestamps and durations persist without arguments or credentials', async (t) => {
  const { path } = await fixture(t);
  let store = await TelemetryStore.open(path);
  const outcomes = ['ok', 'denied', 'cooldown', 'failed'];
  outcomes.forEach((outcome, index) => {
    const entry = command(String(BigInt(command().id) + BigInt(index)), { startedAt: now + index });
    store.startCommand({ ...entry, token: 'must-not-persist', arguments: 'not-stored' });
    store.startCommand(entry);
    store.finishCommand(entry.id, outcome, now + 1000 + index, 1000.4);
    store.finishCommand(entry.id, 'failed', now + 2000, 2000);
  });
  assert.equal(store.status().commandCount, outcomes.length);
  store.close();
  store = await TelemetryStore.open(path);
  t.after(() => store.close());
  const entries = store.recentCommands(20);
  assert.deepEqual(
    entries.map((entry) => entry.outcome),
    outcomes.toReversed(),
  );
  assert.equal(entries[0].finishedAt, now + 1003);
  assert.equal(entries[0].durationMs, 1000);
  assert.equal(entries[0].token, undefined);
  assert.equal(entries[0].arguments, undefined);
  for (const limit of [0, 21, 1.5])
    assert.throws(() => store.recentCommands(limit), { name: 'InvalidAuditLimit' });
});

test('a busy database degrades diagnostics and retries pending metrics after the writer lock clears', async (t) => {
  const { path } = await fixture(t);
  const store = await TelemetryStore.open(path);
  const lock = new DatabaseSync(path);
  t.after(() => {
    lock.close();
    store.close();
  });
  lock.exec('BEGIN IMMEDIATE');
  assert.throws(() => store.recordMetrics([point(now - 60_000)]));
  assert.equal(store.status().healthy, false);
  assert.equal(store.status().pendingSamples, 1);
  assert.equal(store.status().lastSavedAt, null);
  assert.throws(() => store.startCommand(command()));
  assert.equal(store.status().auditFailures, 1);
  lock.exec('ROLLBACK');
  store.recordMetrics([point()]);
  assert.equal(store.status().metricCount, 2);
  assert.equal(store.status().pendingSamples, 0);
  store.startCommand(command());
  store.finishCommand(command().id, 'ok');
  assert.equal(store.status().healthy, true);
  assert.throws(() => store.finishCommand('missing', 'ok'), { name: 'AuditRecordMissing' });
  assert.equal(store.status().auditFailures, 2);
});

test('prolonged storage failure bounds the retry buffer and exposes any dropped unsaved samples', async (t) => {
  const { path } = await fixture(t);
  const store = await TelemetryStore.open(path);
  const lock = new DatabaseSync(path);
  t.after(() => {
    lock.close();
    store.close();
  });
  lock.exec('BEGIN IMMEDIATE');
  const values = Array.from({ length: HISTORY_LIMIT }, (_, i) =>
    point(now - (HISTORY_LIMIT - i) * 60_000),
  );
  assert.throws(() => store.recordMetrics(values));
  assert.throws(() => store.recordMetrics([point()]));
  assert.equal(store.status().pendingSamples, HISTORY_LIMIT);
  assert.equal(store.status().droppedSamples, 1);
  lock.exec('ROLLBACK');
  store.flush();
  assert.equal(store.status().metricCount, HISTORY_LIMIT);
  assert.equal(store.status().healthy, true);
});

test('backups are consistent standalone SQLite snapshots while the live WAL writer remains open', async (t) => {
  const { path } = await fixture(t);
  const store = await TelemetryStore.open(path);
  t.after(() => store.close());
  store.recordMetrics([point()]);
  store.startCommand(command());
  store.finishCommand(command().id, 'ok');
  const destination = await backupDatabase(path);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  store.recordMetrics([point(now + 60_000)]);
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 1);
    assert.equal(copy.prepare('SELECT outcome FROM commands').get().outcome, 'ok');
  } finally {
    copy.close();
  }
  await backupDatabase(path);
  const updated = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(updated.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 2);
  } finally {
    updated.close();
  }
});

test('failed backup leaves a previous snapshot intact and cleans its temporary file', async (t) => {
  const { directory, path } = await fixture(t);
  const store = await TelemetryStore.open(path);
  store.recordMetrics([point()]);
  store.close();
  const destination = await backupDatabase(path);
  const before = await readFile(destination);
  await writeFile(path, 'broken database');
  await assert.rejects(backupDatabase(path));
  assert.deepEqual(await readFile(destination), before);
  assert.equal(
    (await readdir(directory)).some((name) => name.endsWith('.tmp')),
    false,
  );
});

// CI runs this script through stdin inside /app in two replacement containers.
import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from './dist/backup.js';
import { HistoryFileStore } from './dist/storage.js';
import { TelemetryStore } from './dist/telemetry.js';

assert.notEqual(process.getuid(), 0, 'the image must keep its non-root user');
await assert.rejects(writeFile('/app/package.json', 'must not be writable'), { code: 'EROFS' });
const path = '/app/data/optiplex.sqlite';
const legacy = '/app/data/history.json';
const now = Date.now();
if (process.env.HISTORY_SMOKE_PHASE === 'save') {
  const file = new HistoryFileStore(legacy);
  await file.load();
  await file.save([{ at: now - 2 * 86400_000, cpu: 10, memory: 20, temperature: 30 }]);
}
const store = await TelemetryStore.open(path, legacy);
assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 250);
if (process.env.HISTORY_SMOKE_PHASE === 'save') {
  assert.equal(
    store.status().metricCount,
    1,
    'legacy history must be migrated even when older than 24h',
  );
  store.recordMetrics([{ at: now, cpu: 12.5, memory: 25, temperature: 31 }]);
  store.startCommand({
    id: '1562643787510063218',
    command: 'stats',
    actorId: '1562643787510063219',
    guildId: '1562082957022204006',
    channelId: '1562960345860153444',
    startedAt: now,
  });
  store.finishCommand('1562643787510063218', 'ok', now + 100, 100);
} else {
  assert.equal(process.env.HISTORY_SMOKE_PHASE, 'restore');
  assert.equal(
    store.status().metricCount,
    2,
    'a replacement container must retain the entire archive',
  );
  assert.equal(store.recent(now).length, 1, 'only recent data enters the RAM cache');
  assert.equal(store.summary(10080, now).count, 2);
  assert.equal(store.summary(1440, now).cpu.mean, 12.5);
  assert.equal(store.recentCommands()[0].outcome, 'ok');
  assert.equal(store.status().commandCount, 1);
}
const snapshot = await backupDatabase(path);
const backup = new DatabaseSync(snapshot, { readOnly: true });
assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 2);
assert.equal(backup.prepare('SELECT outcome FROM commands').get().outcome, 'ok');
backup.close();
assert.equal(store.status().healthy, true);
assert.equal((await stat(path)).mode & 0o777, 0o600);
assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
assert.equal((await stat(`${legacy}.migrated`)).mode & 0o777, 0o600);
store.close();
console.log(
  `${process.env.HISTORY_SMOKE_PHASE}: SQLite WAL archive, migration, audit and backup verified; non-root and read-only root`,
);

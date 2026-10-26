// CI only: run the real entry point with no network and no real credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

Object.assign(process.env, {
  DISCORD_TOKEN: 'ci.offline.not-a-real-token',
  APPLICATION_ID: '111111111111111111',
  GUILD_ID: '222222222222222222',
  CHANNEL_ID: '333333333333333333',
  DATABASE_FILE: '/tmp/optimon-private/optiplex.sqlite',
  HISTORY_FILE: '/tmp/optimon-private/history.json',
  PUBLIC_DATA_PATH: '/tmp/optimon-public',
  HOST_PROC_PATH: '/host-metrics/proc',
  TEMP_SENSOR_PATH: '/no-sensors-in-ci',
});
await import('./dist/index.js');
let metrics;
for (let i = 0; i < 100; i++) {
  try {
    metrics = JSON.parse(await readFile('/tmp/optimon-public/metrics.json', 'utf8'));
    const health = JSON.parse(await readFile('/tmp/optimon-health.json', 'utf8'));
    await readFile('/tmp/optimon-public/history.json', 'utf8');
    if (health.ready && health.discordReady === false) break;
    metrics = null;
  } catch {
    metrics = null;
  }
  await delay(100);
}
assert.ok(metrics, 'sampling and public history must start while Discord is unreachable');
assert.notEqual(metrics.live.cpuPercent, null);
assert.notEqual(metrics.live.memory, null);
const db = new DatabaseSync('/tmp/optimon-private/optiplex.sqlite', { readOnly: true });
assert.ok(db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n > 0);
assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
db.close();
console.log(
  'Real offline startup persisted a host sample, published live/history exports and reported sampling health.',
);
process.kill(process.pid, 'SIGTERM');

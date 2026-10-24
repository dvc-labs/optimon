import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { HISTORY_LIMIT } from '../dist/history.js';
import { readLegacyHistory, MAX_HISTORY_BYTES } from '../dist/legacy-history.js';
const now = Date.now();
const point = (overrides = {}) => ({
  at: now,
  cpu: 12.5,
  memory: 25,
  temperature: 31,
  ...overrides,
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'optiplex-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'history.json') };
}

test('the read-only legacy importer preserves aggregate values and excludes unrelated fields', async (t) => {
  const { path } = await fixture(t);
  const source = JSON.stringify({
    version: 1,
    points: [point({ token: 'never-import', actorId: 'private-id' })],
  });
  await writeFile(path, source);
  assert.deepEqual(await readLegacyHistory(path), [point()]);
  assert.equal(await readFile(path, 'utf8'), source);
});
test('missing legacy input is harmless; invalid, future and oversized formats remain bounded', async (t) => {
  const { path } = await fixture(t);
  assert.deepEqual(await readLegacyHistory(path), []);
  for (const source of [
    '',
    'null',
    '{broken',
    JSON.stringify({ version: 2, points: [] }),
    JSON.stringify({ version: 1, points: [point({ cpu: 1000 })] }),
    JSON.stringify({ version: 1, points: Array(HISTORY_LIMIT + 1).fill(point()) }),
    ' '.repeat(MAX_HISTORY_BYTES + 1),
  ]) {
    await writeFile(path, source);
    await assert.rejects(readLegacyHistory(path), { name: 'InvalidHistoryFile' });
    assert.equal(await readFile(path, 'utf8'), source);
  }
});
test('legacy input cannot follow a symlink to another file', async (t) => {
  const { directory, path } = await fixture(t);
  const target = join(directory, 'private.json');
  await writeFile(target, 'private fixture');
  await symlink(target, path);
  await assert.rejects(readLegacyHistory(path), { code: 'ELOOP' });
  assert.equal(await readFile(target, 'utf8'), 'private fixture');
});
test('an unsupported database schema stops before Discord login without changing data or exposing secrets', async (t) => {
  const { directory } = await fixture(t);
  const path = join(directory, 'future.sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version=2; CREATE TABLE future(value TEXT);');
  database.close();
  const before = await readFile(path);
  const token = 'fixture-token-that-must-not-appear';
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        DISCORD_TOKEN: token,
        APPLICATION_ID: '1562643787510063217',
        GUILD_ID: '1562082957022204006',
        CHANNEL_ID: '1562960345860153444',
        DATABASE_FILE: path,
      },
    },
  );
  assert.equal(child.status, 1, child.stderr);
  const entries = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'telemetry_initialization_failed');
  assert.equal(entries[0].name, 'UnsupportedTelemetrySchema');
  for (const secret of [token, path]) assert.ok(!(child.stdout + child.stderr).includes(secret));
  assert.deepEqual(await readFile(path), before);
});

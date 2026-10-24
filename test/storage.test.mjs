import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { History, HISTORY_LIMIT, HISTORY_MS } from '../dist/history.js';
import { HistoryFileStore, MAX_HISTORY_BYTES } from '../dist/storage.js';

const now = Date.now();
const point = (overrides = {}) => ({ at: now - 60_000, cpu: 12.5, memory: 25, temperature: 31, ...overrides });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'optiplex-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'data', 'history.json');
  return { directory, path, store: new HistoryFileStore(path) };
}

test('a saved sample survives a new process being killed without a shutdown hook', async (t) => {
  const { path } = await fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { HistoryFileStore } from './dist/storage.js';
    const store = new HistoryFileStore(process.argv[1]);
    await store.load();
    await store.save(JSON.parse(process.argv[2]));
    process.kill(process.pid, 'SIGKILL');
  `, path, JSON.stringify([point()])], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const store = new HistoryFileStore(path);
  const history = new History();
  history.restore(await store.load(), now);
  assert.equal(history.summary(60, now).cpu.mean, 12.5);
  assert.equal(history.summary(60, now).temperature.mean, 31);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
});

test('temporary write failure keeps the last good file and the next save backfills retained readings', async (t) => {
  const { path, store } = await fixture(t);
  assert.deepEqual(await store.load(), []);
  await store.save([point()]);
  const successful = store.status().lastSavedAt;
  await mkdir(`${path}.tmp`);
  const second = point({ at: now, cpu: 50 });
  await assert.rejects(store.save([point(), second]));
  assert.deepEqual(store.status(), { healthy: false, lastSavedAt: successful });
  assert.deepEqual(await new HistoryFileStore(path).load(), [point()]);
  await rm(`${path}.tmp`, { recursive: true });
  await store.save([point(), second]);
  assert.equal(store.status().healthy, true);
  assert.deepEqual(await new HistoryFileStore(path).load(), [point(), second]);
});

test('queued writes capture their input and leave a complete, newest file', async (t) => {
  const { path, store } = await fixture(t);
  await store.load();
  const values = [point()];
  const first = store.save(values);
  values[0].cpu = 80;
  const second = store.save(values);
  values[0].cpu = 99;
  await Promise.all([first, second]);
  assert.equal((await new HistoryFileStore(path).load())[0].cpu, 80);
  await assert.rejects(stat(`${path}.tmp`), { code: 'ENOENT' });
});

test('startup rejects malformed, unsupported and invalid data without replacing it', async (t) => {
  const { path } = await fixture(t);
  await mkdir(join(path, '..'), { recursive: true });
  for (const data of ['{"version":1,"points":[', '', 'null',
    JSON.stringify({ version: 2, points: [point()] }),
    JSON.stringify({ version: 1, points: [point({ cpu: 1000 })] }),
    JSON.stringify({ version: 1, points: Array(HISTORY_LIMIT + 1).fill(point()) }),
    '{"version":1,"points":[{"at":1,"cpu":1e309,"memory":0,"temperature":null}]}']) {
    await writeFile(path, data);
    const store = new HistoryFileStore(path);
    await assert.rejects(store.load(), { name: 'InvalidHistoryFile' });
    await assert.rejects(store.save([]), { name: 'HistoryNotLoaded' });
    assert.equal(await readFile(path, 'utf8'), data);
  }
});

test('the bot rejects corrupt history before login and logs neither file contents nor credentials', async (t) => {
  const { directory, path } = await fixture(t);
  const token = 'fixture-token-that-must-not-appear';
  const content = `private history content ${token}`;
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { DISCORD_TOKEN: token, APPLICATION_ID: '1562643787510063217',
      GUILD_ID: '1562082957022204006', CHANNEL_ID: '1562960345860153444', HISTORY_FILE: path },
  });
  assert.equal(child.status, 1, child.stderr);
  const entries = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'history_storage_initialization_failed');
  assert.equal(entries[0].name, 'InvalidHistoryFile');
  for (const secret of [token, content, path]) assert.ok(!(child.stdout + child.stderr).includes(secret));
  assert.equal(await readFile(path, 'utf8'), content);
});

test('oversized files and excessive writes are rejected within the storage bound', async (t) => {
  const { path, store } = await fixture(t);
  await store.load();
  await store.save([point()]);
  const before = await readFile(path, 'utf8');
  await assert.rejects(store.save(Array(HISTORY_LIMIT + 1).fill(point())), { name: 'InvalidHistoryFile' });
  assert.equal(await readFile(path, 'utf8'), before);
  await writeFile(path, ' '.repeat(MAX_HISTORY_BYTES + 1));
  await assert.rejects(new HistoryFileStore(path).load(), { name: 'InvalidHistoryFile' });
  assert.equal((await stat(path)).size, MAX_HISTORY_BYTES + 1);
});

test('retention is reapplied when restoring a volume after a long downtime', async (t) => {
  const { path, store } = await fixture(t);
  await store.load();
  await store.save([point({ at: now - HISTORY_MS - 1 }), point(), point({ at: now + 60_000 })]);
  const restored = new History();
  restored.restore(await new HistoryFileStore(path).load(), now);
  assert.equal(restored.size, 1);
  await store.save(restored.exportPoints(now));
  assert.deepEqual(await new HistoryFileStore(path).load(), [point()]);
});

test('stale temporary files are ignored and only aggregate metric fields are stored', async (t) => {
  const { path, store } = await fixture(t);
  await store.load();
  await store.save([point({ token: 'should-never-be-persisted', userId: 'private-user' })]);
  await writeFile(`${path}.tmp`, 'incomplete replacement');
  const restored = await new HistoryFileStore(path).load();
  assert.deepEqual(restored, [point()]);
  assert.ok(!(await readFile(path, 'utf8')).includes('should-never-be-persisted'));
  await store.save(restored);
  assert.deepEqual(await new HistoryFileStore(path).load(), [point()]);
});

test('history and temporary file symlinks cannot redirect storage reads or writes', async (t) => {
  const { directory, path, store } = await fixture(t);
  await store.load();
  const target = join(directory, 'outside.json');
  await writeFile(target, 'leave this file alone');
  await symlink(target, path);
  await assert.rejects(new HistoryFileStore(path).load(), { code: 'ELOOP' });
  await rm(path);
  await store.save([point()]);
  await symlink(target, `${path}.tmp`);
  await assert.rejects(store.save([point({ cpu: 90 })]), { code: 'ELOOP' });
  assert.equal(await readFile(target, 'utf8'), 'leave this file alone');
  assert.deepEqual(await new HistoryFileStore(path).load(), [point()]);
});

test('the complete history stays below the file limit and survives restoration', async (t) => {
  const { path, store } = await fixture(t);
  const values = Array.from({ length: HISTORY_LIMIT }, (_, index) => point({
    at: now - index * 60_000, cpu: 12.345678901234567, memory: 23.456789012345678,
    temperature: 34.56789012345678,
  }));
  await store.load();
  await store.save(values);
  const bytes = (await stat(path)).size;
  assert.ok(bytes < MAX_HISTORY_BYTES);
  const history = new History();
  history.restore(await new HistoryFileStore(path).load(), now);
  assert.equal(history.size, HISTORY_LIMIT);
  assert.equal(history.summary(1440, now).cpu.count, HISTORY_LIMIT);
});

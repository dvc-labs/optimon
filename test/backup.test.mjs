import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { backupDatabase, verifyBackup } from '../dist/backup.js';
import { TelemetryStore } from '../dist/telemetry.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'optiplex-backup-'));
  const path = join(directory, 'optiplex.sqlite');
  const store = await TelemetryStore.open(path);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  let at = Date.now();
  return {
    directory,
    path,
    store,
    current: join(directory, 'optiplex.backup.sqlite'),
    previous: join(directory, 'optiplex.backup.previous.sqlite'),
    add: () => store.recordMetrics([{ at: at++, cpu: 10, memory: 20, temperature: 30 }]),
  };
}
function count(path) {
  const uri = pathToFileURL(path);
  uri.searchParams.set('immutable', '1');
  const db = new DatabaseSync(uri.href, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n;
  } finally {
    db.close();
  }
}

test('successful backups retain the current and one previous verified generation without temp sidecars', async (t) => {
  const f = await fixture(t);
  f.add();
  await backupDatabase(f.path);
  f.add();
  await backupDatabase(f.path);
  assert.equal(count(f.current), 2);
  assert.equal(count(f.previous), 1);
  f.add();
  await backupDatabase(f.path);
  assert.equal(count(f.current), 3);
  assert.equal(count(f.previous), 2);
  for (const file of [f.current, f.previous]) {
    verifyBackup(file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  assert.equal(
    (await readdir(f.directory)).some((name) => name.includes('.tmp')),
    false,
  );
});
test('a physically readable but logically corrupt snapshot cannot replace either good backup', async (t) => {
  const f = await fixture(t);
  f.add();
  await backupDatabase(f.path);
  f.add();
  await backupDatabase(f.path);
  const current = await readFile(f.current);
  const previous = await readFile(f.previous);
  f.store.db.exec('PRAGMA ignore_check_constraints=ON; INSERT INTO metrics(at,cpu) VALUES(1,999);');
  await assert.rejects(backupDatabase(f.path), { name: 'CorruptBackupDatabase' });
  assert.deepEqual(await readFile(f.current), current);
  assert.deepEqual(await readFile(f.previous), previous);
  assert.equal(
    (await readdir(f.directory)).some((name) => name.includes('.tmp')),
    false,
  );
});
test('a damaged current backup never rotates over a good previous generation', async (t) => {
  const f = await fixture(t);
  f.add();
  await backupDatabase(f.path);
  f.add();
  await backupDatabase(f.path);
  const previous = await readFile(f.previous);
  await writeFile(f.current, 'corrupt current backup');
  f.add();
  await backupDatabase(f.path);
  assert.equal(count(f.current), 3);
  assert.deepEqual(await readFile(f.previous), previous);
});
test('interruption after rotation leaves the good previous copy recoverable and the next run can publish again', async (t) => {
  const f = await fixture(t);
  f.add();
  await backupDatabase(f.path);
  f.add();
  await backupDatabase(f.path);
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
  import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{rename(from,to);if(to.endsWith('.backup.previous.sqlite'))process.kill(process.pid,'SIGKILL');};
  syncBuiltinESMExports();
  const {backupDatabase}=await import('./dist/backup.js');await backupDatabase(process.argv[1]);
 `,
      f.path,
    ],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(count(f.previous), 2);
  verifyBackup(f.previous);
  await backupDatabase(f.path);
  assert.equal(count(f.current), 2);
  assert.equal(count(f.previous), 2);
});
test('backup paths cannot redirect writes through symlinks or accept unsupported schemas', async (t) => {
  const f = await fixture(t);
  f.add();
  await backupDatabase(f.path);
  const current = await readFile(f.current);
  await symlink(f.current, f.previous);
  await assert.rejects(backupDatabase(f.path), { name: 'UnsafeBackupPath' });
  assert.deepEqual(await readFile(f.current), current);
  const future = join(f.directory, 'future.sqlite');
  const db = new DatabaseSync(future);
  db.exec('PRAGMA user_version=2');
  db.close();
  assert.throws(() => verifyBackup(future), { name: 'UnsupportedBackupSchema' });
});
test('snapshot verification refuses WAL-dependent files and the CLI redacts failures', async (t) => {
  const f = await fixture(t);
  f.add();
  await backupDatabase(f.path);
  await writeFile(f.current + '-wal', 'not a standalone snapshot');
  assert.throws(() => verifyBackup(f.current), { name: 'BackupRequiresWAL' });
  const child = spawnSync(process.execPath, ['dist/backup-cli.js', '--verify', f.current], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.status, 1);
  assert.ok(!child.stdout.includes(f.current));
  assert.ok(!child.stderr.includes(f.current));
  assert.match(child.stdout, /database_backup_failed/);
});

test('the documented offline restore script removes stale live sidecars and preserves the old generation', async (t) => {
  const f = await fixture(t);
  f.add();
  await backupDatabase(f.path);
  f.add();
  f.store.close();
  await writeFile(f.path + '-wal', 'stale WAL fixture');
  await writeFile(f.path + '-shm', 'stale SHM fixture');
  const guide = await readFile(new URL('../BACKUPS.md', import.meta.url), 'utf8');
  const start = guide.indexOf('--entrypoint /bin/sh "$opti_image" -c \'\n');
  assert.ok(start >= 0);
  const script = guide
    .slice(start)
    .split(" -c '\n")[1]
    .split("\n    '\nfi")[0]
    .replaceAll('/app/data', f.directory);
  const restored = spawnSync('/bin/sh', ['-c', script], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.equal(count(f.path), 1);
  verifyBackup(f.path);
  const saved = (await readdir(f.directory)).find((name) => name.startsWith('pre-restore-'));
  assert.ok(saved);
  assert.equal(
    await readFile(join(f.directory, saved, 'optiplex.sqlite-wal'), 'utf8'),
    'stale WAL fixture',
  );
  assert.equal(
    await readFile(join(f.directory, saved, 'optiplex.sqlite-shm'), 'utf8'),
    'stale SHM fixture',
  );
  assert.equal((await stat(join(f.directory, saved))).mode & 0o777, 0o700);
  assert.equal((await readdir(f.directory)).includes('optiplex.sqlite-wal'), false);
});

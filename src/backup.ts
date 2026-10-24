import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

/** A known existing artifact blocks safe promotion; report its basename and a recovery action. */
export class BackupBlockedError extends Error {
  constructor(
    readonly fileName: string,
    readonly reason: string,
  ) {
    super('Existing backup could not be verified.');
    this.name = 'BackupBlockedError';
  }
}

function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}
function regularFile(path: string): void {
  if (!lstatSync(path).isFile()) throw namedError('UnsafeBackupPath');
}
function syncDirectory(path: string): void {
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Validate a standalone snapshot before promotion or an offline restore. Never log its contents. */
export function verifyBackup(path: string): void {
  regularFile(path);
  if (existsSync(`${path}-wal`)) {
    regularFile(`${path}-wal`);
    if (lstatSync(`${path}-wal`).size > 0) throw namedError('BackupRequiresWAL');
  }
  let db: DatabaseSync | undefined;
  try {
    // Only standalone snapshots are immutable. This avoids creating WAL/SHM files
    // merely to inspect a snapshot whose header still records WAL mode.
    const uri = pathToFileURL(path);
    uri.searchParams.set('immutable', '1');
    db = new DatabaseSync(uri.href, { readOnly: true, timeout: 250, allowExtension: false });
    const rows = db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok')
      throw namedError('CorruptBackupDatabase');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
      throw namedError('UnsupportedBackupSchema');
    try {
      db.prepare('SELECT at,cpu,memory,temperature FROM metrics LIMIT 0').all();
      db.prepare('SELECT id,actorId,startedAt,outcome FROM commands LIMIT 0').all();
      db.prepare('SELECT key,value FROM metadata LIMIT 0').all();
    } catch {
      throw namedError('CorruptBackupDatabase');
    }
    // Validate application ranges too; a structurally readable file can contain
    // invalid readings (for example after constraints were disabled elsewhere).
    if (
      db
        .prepare(
          `SELECT 1 FROM metrics WHERE at NOT BETWEEN 0 AND 8640000000000000
      OR cpu NOT BETWEEN 0 AND 100 OR memory NOT BETWEEN 0 AND 100
      OR temperature NOT BETWEEN -30 AND 150 LIMIT 1`,
        )
        .get()
    )
      throw namedError('CorruptBackupDatabase');
  } catch (error) {
    const code = (error as { errcode?: number }).errcode;
    if (code === 11 || code === 26) throw namedError('CorruptBackupDatabase');
    throw error;
  } finally {
    db?.close();
  }
}

/** Check first, then retain one verified previous generation before publishing atomically. */
export async function backupDatabase(source: string): Promise<string> {
  regularFile(source);
  const stem = source.replace(/\.sqlite$/, '');
  const destination = `${stem}.backup.sqlite`;
  const previous = `${stem}.backup.previous.sqlite`;
  for (const path of [destination, previous]) if (existsSync(path)) regularFile(path);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  closeSync(openSync(temporary, 'ax', 0o600));
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(source, { readOnly: true, timeout: 250, allowExtension: false });
    await backup(database, temporary, { rate: 256 });
    database.close();
    database = undefined;
    verifyBackup(temporary);
    const file = openSync(temporary, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    let rotate = existsSync(destination);
    if (rotate) {
      try {
        verifyBackup(destination);
      } catch (error) {
        if ((error as Error).name !== 'CorruptBackupDatabase') {
          const reason = (error as { name?: string }).name;
          throw new BackupBlockedError(
            basename(destination),
            reason && /^[A-Za-z0-9_.-]{1,80}$/.test(reason) ? reason : 'VerificationFailed',
          );
        }
        rotate = false; // Never replace the good previous generation with a damaged current one.
      }
    }
    if (rotate) {
      chmodSync(destination, 0o600);
      renameSync(destination, previous);
      syncDirectory(destination);
    }
    renameSync(temporary, destination);
    syncDirectory(destination);
    return destination;
  } finally {
    database?.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

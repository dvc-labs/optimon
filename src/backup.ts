import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

/** Produce one consistent standalone SQLite file while the live writer keeps running. */
export async function backupDatabase(source: string): Promise<string> {
  if (!lstatSync(source).isFile())
    throw Object.assign(new Error('Unsafe backup source.'), { name: 'UnsafeBackupPath' });
  const destination = `${source.replace(/\.sqlite$/, '')}.backup.sqlite`;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  closeSync(openSync(temporary, 'ax', 0o600));
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(source, { readOnly: true, timeout: 250, allowExtension: false });
    await backup(database, temporary, { rate: 256 });
    const file = openSync(temporary, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, destination);
    const directory = openSync(dirname(source), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return destination;
  } finally {
    database?.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

import { isAbsolute, resolve } from 'node:path';
import { backupDatabase } from './backup.js';
import { log, safeError } from './log.js';

try {
  const source = process.env.DATABASE_FILE?.trim() || resolve('data/optiplex.sqlite');
  if (!isAbsolute(source))
    throw Object.assign(new Error('Invalid backup source.'), { name: 'InvalidBackupPath' });
  await backupDatabase(source);
  log('database_backup_created');
} catch (error) {
  log('database_backup_failed', safeError(error));
  process.exit(1);
}

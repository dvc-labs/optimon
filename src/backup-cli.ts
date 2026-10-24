import { isAbsolute, resolve } from 'node:path';
import { backupDatabase, verifyBackup, BackupBlockedError } from './backup.js';
import { log, safeError } from './log.js';

try {
  const source = process.env.DATABASE_FILE?.trim() || resolve('data/optiplex.sqlite');
  if (!isAbsolute(source))
    throw Object.assign(new Error('Invalid backup source.'), { name: 'InvalidBackupPath' });
  const args = process.argv.slice(2);
  if (!args.length) {
    await backupDatabase(source);
    log('database_backup_created');
  } else if (args.length === 2 && args[0] === '--verify' && isAbsolute(args[1]!)) {
    verifyBackup(args[1]!);
    log('database_backup_verified');
  } else
    throw Object.assign(new Error('Use backup, or backup -- --verify /absolute/snapshot.sqlite.'), {
      name: 'InvalidBackupArguments',
    });
} catch (error) {
  if (error instanceof BackupBlockedError) {
    log('database_backup_blocked', {
      ...safeError(error),
      file: error.fileName,
      reason: error.reason,
      action: 'Preserve this existing file, move it aside, then rerun the backup. See BACKUPS.md.',
    });
  } else log('database_backup_failed', safeError(error));
  process.exit(1);
}

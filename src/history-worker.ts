import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { querySummary, queryComparison, type QueryKind } from './history-query.js';
import { safeError } from './log.js';
import { queryDashboard } from './dashboard-query.js';
import { queryAvailability } from './availability.js';

if (!parentPort) throw new Error('History worker requires a parent port.');
const port = parentPort;
const db = new DatabaseSync(workerData.path as string, {
  readOnly: true,
  timeout: 250,
  allowExtension: false,
});
db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-4096;');
if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
  throw Object.assign(new Error('Unsupported archive schema.'), {
    name: 'UnsupportedTelemetrySchema',
  });
port.on('message', (request: { id: number; kind: QueryKind; minutes: number; now: number }) => {
  try {
    // All aggregate/bucket reads, including both comparison windows, share one WAL snapshot.
    db.exec('BEGIN');
    const result =
      request.kind === 'availability'
        ? queryAvailability(db, request.now)
        : request.kind === 'dashboard'
          ? queryDashboard(db, request.now)
          : request.kind === 'summary'
            ? querySummary(db, request.minutes, request.now)
            : queryComparison(db, request.minutes, request.now);
    db.exec('COMMIT');
    port.postMessage({ id: request.id, result });
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    port.postMessage({ id: request.id, error: safeError(error) });
  }
});

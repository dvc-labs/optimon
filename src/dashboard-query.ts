import type { DatabaseSync } from 'node:sqlite';
import {
  DASHBOARD_WINDOWS,
  PUBLIC_BUCKETS,
  type PublicAggregate,
  type PublicHistory,
} from './dashboard-data.js';
import { roundMetric } from './history.js';
import { queryAvailability } from './availability.js';

/** Runs only in the existing read-only query worker, never on the Discord/HTTP event loop. */
export function queryDashboard(db: DatabaseSync, now = Date.now()): PublicHistory {
  const total = db
    .prepare('SELECT COUNT(*) AS n, MIN(at) AS firstAt, MAX(at) AS lastAt FROM metrics WHERE at<=?')
    .get(now)!;
  const columns = ['cpu', 'memory', 'temperature'] as const;
  const aggregateSql = columns
    .map(
      (c) =>
        `COUNT(${c}) AS ${c}Count, MIN(${c}) AS ${c}Min, AVG(${c}) AS ${c}Mean, MAX(${c}) AS ${c}Max`,
    )
    .join(',');
  const aggregateQuery = db.prepare(
    `SELECT COUNT(*) AS n, ${aggregateSql} FROM metrics WHERE at>=? AND at<?`,
  );
  const bucketQuery = db.prepare(
    'SELECT AVG(cpu) AS cpu, AVG(memory) AS memory, AVG(temperature) AS temperature FROM metrics WHERE at>=? AND at<?',
  );
  const firstAt = total.firstAt === null ? null : Number(total.firstAt);
  return {
    generatedAt: now,
    firstAt,
    lastAt: total.lastAt === null ? null : Number(total.lastAt),
    totalSamples: Number(total.n),
    availability: queryAvailability(db, now),
    windows: DASHBOARD_WINDOWS.map(({ key, minutes }) => {
      const from = minutes ? Math.max(0, now - minutes * 60_000) : (firstAt ?? now);
      const to = now + 1;
      const row = aggregateQuery.get(from, to)!;
      const metric = (c: (typeof columns)[number]): PublicAggregate | null =>
        Number(row[`${c}Count`])
          ? {
              count: Number(row[`${c}Count`]),
              min: Number(row[`${c}Min`]),
              mean: roundMetric(Number(row[`${c}Mean`]))!,
              max: Number(row[`${c}Max`]),
            }
          : null;
      return {
        key,
        from,
        to,
        count: Number(row.n),
        cpu: metric('cpu'),
        memory: metric('memory'),
        temperature: metric('temperature'),
        points: Array.from({ length: PUBLIC_BUCKETS }, (_, i) => {
          const start = Math.ceil(from + ((to - from) * i) / PUBLIC_BUCKETS);
          const end = Math.ceil(from + ((to - from) * (i + 1)) / PUBLIC_BUCKETS);
          const bucket = bucketQuery.get(start, end)!;
          const value = (c: (typeof columns)[number]) =>
            bucket[c] === null ? null : roundMetric(Number(bucket[c]));
          return {
            at: Math.floor((start + end) / 2),
            cpu: value('cpu'),
            memory: value('memory'),
            temperature: value('temperature'),
          };
        }),
      };
    }),
  };
}

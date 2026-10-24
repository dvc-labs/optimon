import type { DatabaseSync } from 'node:sqlite';
import type { PublicHistory } from './dashboard-data.js';
import {
  HISTORY_WINDOWS,
  historyGraph,
  type HistorySummary,
  type MetricSummary,
} from './history.js';
export interface HistoryComparison {
  current: HistorySummary;
  previous: HistorySummary;
}
export type QueryKind = 'summary' | 'compare' | 'dashboard';
export type QueryResult = HistorySummary | HistoryComparison | PublicHistory;
export interface HistoryReader {
  summary(minutes: number): Promise<HistorySummary>;
  compare(minutes: number): Promise<HistoryComparison>;
  close(): Promise<void>;
}
function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}
export function querySummary(db: DatabaseSync, minutes: number, now = Date.now()): HistorySummary {
  return range(db, minutes, now - minutes * 60_000, now + 1);
}

export function queryComparison(
  db: DatabaseSync,
  minutes: number,
  now = Date.now(),
): HistoryComparison {
  const from = now - minutes * 60_000;
  return {
    current: range(db, minutes, from, now + 1),
    previous: range(db, minutes, from - minutes * 60_000, from),
  };
}

function range(db: DatabaseSync, minutes: number, from: number, to: number): HistorySummary {
  if (!(HISTORY_WINDOWS as readonly number[]).includes(minutes))
    throw namedError('UnsupportedHistoryWindow');
  const columns = ['cpu', 'memory', 'temperature'] as const;
  const aggregates = columns
    .map(
      (column) =>
        `COUNT(${column}) AS ${column}Count, MIN(${column}) AS ${column}Min, AVG(${column}) AS ${column}Mean, MAX(${column}) AS ${column}Max`,
    )
    .join(',');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(at) AS firstAt, MAX(at) AS lastAt, ${aggregates} FROM metrics WHERE at>=? AND at<?`,
    )
    .get(from, to)!;
  // Indexed ranges avoid a GROUP BY sort that could spill a year of data into /tmp.
  const bucketQuery = db.prepare(
    'SELECT AVG(cpu) AS cpu, AVG(memory) AS memory, AVG(temperature) AS temperature FROM metrics WHERE at>=? AND at<?',
  );
  const bins = Array.from({ length: 24 }, (_, bucket) => {
    const values = bucketQuery.get(
      Math.ceil(from + ((to - from) * bucket) / 24),
      Math.ceil(from + ((to - from) * (bucket + 1)) / 24),
    )!;
    return { bucket, cpu: values.cpu, memory: values.memory, temperature: values.temperature };
  });
  const metric = (column: (typeof columns)[number]): MetricSummary | null => {
    const count = Number(row[`${column}Count`]);
    if (!count) return null;
    const buckets: (number | null)[] = Array(24).fill(null);
    for (const bin of bins)
      buckets[Number(bin.bucket)] = bin[column] === null ? null : Number(bin[column]);
    return {
      count,
      min: Number(row[`${column}Min`]),
      mean: Number(row[`${column}Mean`]),
      max: Number(row[`${column}Max`]),
      graph: historyGraph(buckets),
    };
  };
  return {
    minutes,
    count: Number(row.n),
    firstAt: row.firstAt === null ? null : Number(row.firstAt),
    lastAt: row.lastAt === null ? null : Number(row.lastAt),
    cpu: metric('cpu'),
    memory: metric('memory'),
    temperature: metric('temperature'),
  };
}

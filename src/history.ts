import { hottestTemperature, type Snapshot } from './metrics.js';

export const HISTORY_LIMIT = 1440;
export const QUERY_CACHE_MS = 60_000;
export const QUERY_TIMEOUT_MS = 10_000;
const BARS = '▁▂▃▄▅▆▇█';
export const HISTORY_WINDOWS = [60, 360, 1440, 10080, 43200, 525600] as const;
export function historyGraph(values: readonly (number | null)[]): string {
  return values
    .map((value) =>
      value === null ? '·' : BARS[Math.max(0, Math.min(7, Math.floor((value / 100) * 8)))],
    )
    .join('');
}
export function roundMetric(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}
export interface HistoryPoint {
  at: number;
  cpu: number | null;
  memory: number | null;
  temperature: number | null;
}
export function isHistoryPoint(value: unknown): value is HistoryPoint {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Record<string, unknown>;
  const metric = (reading: unknown, min: number, max: number): boolean =>
    reading === null ||
    (typeof reading === 'number' && Number.isFinite(reading) && reading >= min && reading <= max);
  return (
    typeof point.at === 'number' &&
    Number.isSafeInteger(point.at) &&
    point.at >= 0 &&
    point.at <= 8_640_000_000_000_000 &&
    metric(point.cpu, 0, 100) &&
    metric(point.memory, 0, 100) &&
    metric(point.temperature, -30, 150)
  );
}
export interface MetricSummary {
  count: number;
  min: number;
  mean: number;
  max: number;
  graph: string;
}
export interface HistorySummary {
  minutes: number;
  count: number;
  firstAt: number | null;
  lastAt: number | null;
  cpu: MetricSummary | null;
  memory: MetricSummary | null;
  temperature: MetricSummary | null;
}

/** Durable timestamp keys deduplicate samples; no separate history array is needed. */
export function pointFromSnapshot(snapshot: Snapshot): HistoryPoint | null {
  const point = {
    at: snapshot.capturedAt.getTime(),
    cpu: roundMetric(snapshot.cpuPercent),
    memory: roundMetric(snapshot.memory?.percent ?? null),
    temperature: roundMetric(hottestTemperature(snapshot)),
  };
  return isHistoryPoint(point) ? point : null;
}

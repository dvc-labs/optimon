import { hottestTemperature, type Snapshot } from './metrics.js';

export const HISTORY_LIMIT = 1440;
export const HISTORY_MS = 24 * 60 * 60_000;
const BARS = '▁▂▃▄▅▆▇█';
interface Point { at: number; cpu: number | null; memory: number | null; temperature: number | null }
export interface MetricSummary { count: number; min: number; mean: number; max: number; graph: string }
export interface HistorySummary {
  minutes: number; count: number; firstAt: number | null; lastAt: number | null;
  cpu: MetricSummary | null; memory: MetricSummary | null; temperature: MetricSummary | null;
}

function summarize(points: Point[], key: 'cpu' | 'memory' | 'temperature',
  from: number, to: number): MetricSummary | null {
  const values = points.map((point) => point[key]).filter((value): value is number => value !== null);
  if (!values.length) return null;
  const bins: number[][] = Array.from({ length: 24 }, () => []);
  for (const point of points) {
    const value = point[key];
    if (value === null) continue;
    const index = Math.min(23, Math.floor((point.at - from) / (to - from) * 24));
    bins[index]!.push(value);
  }
  return {
    count: values.length, min: Math.min(...values), max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    // Fixed 0–100 scale for percentages and °C; empty time buckets stay visible.
    graph: bins.map((bin) => {
      if (!bin.length) return '·';
      const mean = bin.reduce((sum, value) => sum + value, 0) / bin.length;
      return BARS[Math.max(0, Math.min(7, Math.floor(mean / 100 * 8)))];
    }).join(''),
  };
}

export class History {
  private points: Point[] = [];
  get size(): number { return this.points.length; }

  record(snapshot: Snapshot): void {
    const at = snapshot.capturedAt.getTime();
    if (!Number.isFinite(at)) return;
    // A cached snapshot must not count twice; only periodic samples are recorded.
    if (this.points.some((point) => point.at === at)) return;
    this.points = this.points.filter((point) => point.at >= at - HISTORY_MS && point.at <= at);
    this.points.push({ at, cpu: snapshot.cpuPercent, memory: snapshot.memory?.percent ?? null,
      temperature: hottestTemperature(snapshot) });
    if (this.points.length > HISTORY_LIMIT) this.points.splice(0, this.points.length - HISTORY_LIMIT);
  }

  summary(minutes: number, now = Date.now()): HistorySummary {
    if (![60, 360, 1440].includes(minutes)) throw new Error('Unsupported history window.');
    const from = now - minutes * 60_000;
    const points = this.points.filter((point) => point.at >= from && point.at <= now);
    return {
      minutes, count: points.length, firstAt: points[0]?.at ?? null,
      lastAt: points.at(-1)?.at ?? null,
      cpu: summarize(points, 'cpu', from, now), memory: summarize(points, 'memory', from, now),
      temperature: summarize(points, 'temperature', from, now),
    };
  }
}

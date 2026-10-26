import type { DatabaseSync } from 'node:sqlite';
import { roundMetric } from './history.js';
import { SAMPLE_INTERVAL_MS } from './monitoring.js';

export const GAP_THRESHOLD_MS = 210_000;
export const AVAILABILITY_DAYS = [7, 30] as const;
export interface MonitoringGap {
  lastSeenAt: number;
  resumedAt: number | null;
  durationMs: number;
}
export interface AvailabilityWindow {
  days: number;
  from: number;
  to: number;
  observedFrom: number | null;
  recordedMinutes: number;
  expectedMinutes: number;
  coveragePercent: number | null;
  gapCount: number;
  missingMs: number;
  recentGaps: MonitoringGap[];
}
export interface MonitoringAvailability {
  generatedAt: number;
  firstAt: number | null;
  lastAt: number | null;
  windows: AvailabilityWindow[];
}

/** Derived on the read-only worker: missing monitoring is not proof of host downtime. */
export function queryAvailability(db: DatabaseSync, now = Date.now()): MonitoringAvailability {
  const bounds = db
    .prepare(
      'SELECT (SELECT MIN(at) FROM metrics WHERE at<=?) AS firstAt, (SELECT MAX(at) FROM metrics WHERE at<=?) AS lastAt',
    )
    .get(now, now)!;
  const firstAt = bounds.firstAt === null ? null : Number(bounds.firstAt);
  const lastAt = bounds.lastAt === null ? null : Number(bounds.lastAt);
  return {
    generatedAt: now,
    firstAt,
    lastAt,
    windows: AVAILABILITY_DAYS.map((days) => {
      const from = Math.max(0, now - days * 86400_000);
      const observedFrom = firstAt === null ? null : Math.max(from, firstAt);
      const expectedMinutes =
        observedFrom === null
          ? 0
          : Math.floor(now / SAMPLE_INTERVAL_MS) -
            Math.floor(observedFrom / SAMPLE_INTERVAL_MS) +
            1;
      const recordedMinutes =
        observedFrom === null
          ? 0
          : Number(
              db
                .prepare(
                  'SELECT COUNT(DISTINCT CAST(at / ? AS INTEGER)) AS n FROM metrics WHERE at>=? AND at<=?',
                )
                .get(SAMPLE_INTERVAL_MS, observedFrom, now)!.n,
            );
      // Include the predecessor so a gap crossing the left edge is not silently lost.
      const cte = `WITH ordered AS (
        SELECT at, LEAD(at) OVER (ORDER BY at) AS next FROM metrics
        WHERE at >= COALESCE((SELECT MAX(at) FROM metrics WHERE at < ?), ?) AND at <= ?
      ), gaps AS (
        SELECT at AS lastSeenAt, next AS resumedAt,
          MIN(COALESCE(next, ?), ?) - MAX(at + ?, ?) AS durationMs
        FROM ordered WHERE COALESCE(next, ?) - at > ?
      )`;
      const args = [from, from, now, now, now, SAMPLE_INTERVAL_MS, from, now, GAP_THRESHOLD_MS];
      const totals = db
        .prepare(
          `${cte} SELECT COUNT(*) AS n, COALESCE(SUM(durationMs), 0) AS missingMs FROM gaps WHERE durationMs>0`,
        )
        .get(...args)!;
      const recentGaps = db
        .prepare(
          `${cte} SELECT lastSeenAt, resumedAt, durationMs FROM gaps WHERE durationMs>0 ORDER BY lastSeenAt DESC LIMIT 5`,
        )
        .all(...args)
        .map((row) => ({
          lastSeenAt: Number(row.lastSeenAt),
          resumedAt: row.resumedAt === null ? null : Number(row.resumedAt),
          durationMs: Number(row.durationMs),
        }));
      return {
        days,
        from,
        to: now,
        observedFrom,
        recordedMinutes,
        expectedMinutes,
        coveragePercent: expectedMinutes
          ? roundMetric(Math.min(100, (recordedMinutes / expectedMinutes) * 100))
          : null,
        gapCount: Number(totals.n),
        missingMs: Number(totals.missingMs),
        recentGaps,
      };
    }),
  };
}

export interface StartupContext {
  previousAt: number | null;
  firstAt: number;
  bootTime: number | null;
}

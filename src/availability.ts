import type { DatabaseSync } from 'node:sqlite';
import { roundMetric } from './history.js';

/** Includes collection time and normal scheduler jitter; does not imply continuous observation. */
export const COVERAGE_GRACE_MS = 90_000;
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
  observedMs: number;
  coveredMs: number;
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
      const observedMs = observedFrom === null ? 0 : now - observedFrom;
      // Include the predecessor so a gap crossing the left edge is not silently lost.
      const cte = `WITH ordered AS (
        SELECT at, LEAD(at) OVER (ORDER BY at) AS next FROM metrics
        WHERE at >= COALESCE((SELECT MAX(at) FROM metrics WHERE at < ?), ?) AND at <= ?
      ), intervals AS (
        SELECT at AS lastSeenAt, next AS resumedAt,
          MAX(0, COALESCE(next, ?) - MAX(at + ?, ?)) AS durationMs,
          COALESCE(next, ?) - at AS spacingMs
        FROM ordered
      )`;
      const args = [from, from, now, now, COVERAGE_GRACE_MS, from, now];
      const totals = db
        .prepare(
          `${cte} SELECT COALESCE(SUM(CASE WHEN spacingMs>? THEN 1 ELSE 0 END), 0) AS n,
            COALESCE(SUM(durationMs), 0) AS missingMs FROM intervals WHERE durationMs>0`,
        )
        .get(...args, GAP_THRESHOLD_MS)!;
      const missingMs = Number(totals.missingMs);
      const coveredMs = Math.max(0, observedMs - missingMs);
      const recentGaps = db
        .prepare(
          `${cte} SELECT lastSeenAt, resumedAt, durationMs FROM intervals
            WHERE durationMs>0 AND spacingMs>? ORDER BY lastSeenAt DESC LIMIT 5`,
        )
        .all(...args, GAP_THRESHOLD_MS)
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
        observedMs,
        coveredMs,
        coveragePercent: observedMs ? roundMetric((coveredMs / observedMs) * 100) : null,
        gapCount: Number(totals.n),
        missingMs,
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

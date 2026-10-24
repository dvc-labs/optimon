import { hottestTemperature, type Snapshot } from './metrics.js';

export const SAMPLE_INTERVAL_MS = 60_000;
export const SNAPSHOT_CACHE_MS = 15_000;

export class MetricsCache {
  private pending: Promise<Snapshot> | null = null;
  last: Snapshot | null = null;
  constructor(
    private readonly collect: () => Promise<Snapshot>,
    private readonly now: () => number = Date.now,
  ) {}

  async getSnapshot(): Promise<Snapshot> {
    const age = this.last ? this.now() - this.last.capturedAt.getTime() : Infinity;
    if (this.last && age >= 0 && age < SNAPSHOT_CACHE_MS) return this.last;
    if (this.pending) return this.pending;
    this.pending = this.collect();
    try {
      this.last = await this.pending;
      return this.last;
    } finally {
      this.pending = null;
    }
  }
}

export type ThermalEvent = 'hot' | 'recovered';
export const THERMAL_WARN_C = 80;
export const THERMAL_RECOVER_C = 75;
export class ThermalWatch {
  active = false;
  private hotSamples = 0;
  private coolSamples = 0;
  private lastAt: number | null = null;

  observe(snapshot: Snapshot): ThermalEvent | null {
    const at = snapshot.capturedAt.getTime();
    if (at === this.lastAt) return null;
    if (this.lastAt !== null && (at < this.lastAt || at - this.lastAt > 150_000)) {
      this.hotSamples = 0;
      this.coolSamples = 0;
    }
    this.lastAt = at;
    const value = hottestTemperature(snapshot);
    if (value === null) {
      this.hotSamples = 0;
      this.coolSamples = 0;
      return null;
    }
    this.hotSamples = value >= THERMAL_WARN_C ? Math.min(2, this.hotSamples + 1) : 0;
    this.coolSamples = value <= THERMAL_RECOVER_C ? Math.min(2, this.coolSamples + 1) : 0;
    if (!this.active && this.hotSamples >= 2) return 'hot';
    if (this.active && this.coolSamples >= 2) return 'recovered';
    return null;
  }

  // Commit only after Discord accepted the notification; failed sends can retry.
  confirm(event: ThermalEvent): void {
    this.active = event === 'hot';
    this.hotSamples = 0;
    this.coolSamples = 0;
  }
}

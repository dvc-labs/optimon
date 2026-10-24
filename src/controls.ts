export interface ReportStatus {
  pausedUntil: number | null;
  lastReportAt: number | null;
  failures: number;
  thermalFailures: number;
}

export class ReportControls {
  private pauseUntil = 0;
  lastReportAt: number | null = null;
  failures = 0;
  thermalFailures = 0;

  pause(minutes: number, now = Date.now()): number {
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
      throw new Error('Pause duration must be 5 to 1440 minutes.');
    }
    this.pauseUntil = now + minutes * 60_000;
    return this.pauseUntil;
  }
  resume(): void {
    this.pauseUntil = 0;
  }
  isPaused(now = Date.now()): boolean {
    return this.pauseUntil > now;
  }
  status(now = Date.now()): ReportStatus {
    return {
      pausedUntil: this.isPaused(now) ? this.pauseUntil : null,
      lastReportAt: this.lastReportAt,
      failures: this.failures,
      thermalFailures: this.thermalFailures,
    };
  }
}

export class Cooldown {
  private until = new Map<string, number>();
  constructor(
    private readonly intervalMs: number,
    private readonly limit = 1000,
  ) {}
  take(key: string, now = Date.now()): number {
    for (const [id, expiry] of this.until) if (expiry <= now) this.until.delete(id);
    const remaining = (this.until.get(key) ?? 0) - now;
    if (remaining > 0) return remaining;
    if (this.until.size >= this.limit) this.until.delete(this.until.keys().next().value!);
    this.until.set(key, now + this.intervalMs);
    return 0;
  }
}

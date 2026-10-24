export interface ExternalHeartbeatStatus {
  enabled: boolean;
  lastSuccessAt: number | null;
  failures: number;
}

export class ExternalHeartbeat {
  private lastSuccessAt: number | null = null;
  private failures = 0;
  private stopping = new AbortController();
  constructor(
    private readonly url: string | null,
    private readonly request: typeof fetch = fetch,
  ) {}
  status(): ExternalHeartbeatStatus {
    return {
      enabled: this.url !== null,
      lastSuccessAt: this.lastSuccessAt,
      failures: this.failures,
    };
  }
  async ping(): Promise<void> {
    if (!this.url || this.stopping.signal.aborted) return;
    try {
      const response = await this.request(this.url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([this.stopping.signal, AbortSignal.timeout(5000)]),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw Object.assign(new Error('Heartbeat rejected.'), {
          name: 'HeartbeatRejected',
          status: response.status,
        });
      this.lastSuccessAt = Date.now();
    } catch (error) {
      if (this.stopping.signal.aborted) return;
      this.failures++;
      throw error;
    }
  }
  stop(): void {
    this.stopping.abort();
  }
}

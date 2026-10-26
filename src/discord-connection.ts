import { setTimeout as delay } from 'node:timers/promises';
import { log, safeError } from './log.js';

export interface ConnectionStatus {
  connected: boolean;
  loginFailures: number;
  registrationFailures: number;
  reconnects: number;
  lastReadyAt: number | null;
  lastDisconnectAt: number | null;
  lastResumeAt: number | null;
}
interface DiscordAdapter {
  login(): Promise<unknown>;
  destroy(): Promise<void>;
  isReady(): boolean;
  prepare(): Promise<void>;
}
type Wait = (ms: number, signal: AbortSignal) => Promise<void>;
const wait: Wait = async (ms, signal) => {
  await delay(ms, undefined, { signal });
};

interface LoginClient {
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
}
/** discord.js destroys its client on failed login; never retry that dead WebSocket manager. */
export class DiscordClientSlot<T extends LoginClient> {
  private client: T;
  private replace = false;
  constructor(
    private readonly create: () => T,
    private readonly attach: (client: T) => void,
  ) {
    this.client = create();
    attach(this.client);
  }
  get current(): T {
    return this.client;
  }
  login(token: string): Promise<unknown> {
    if (this.replace) {
      this.client = this.create();
      this.attach(this.client);
      this.replace = false;
    }
    return this.client.login(token);
  }
  async destroy(): Promise<void> {
    this.replace = true;
    await this.client.destroy();
  }
}

/** Retry initial login/command setup; discord.js continues to own established-session reconnects. */
export class DiscordConnection {
  private readonly abort = new AbortController();
  private loginTask: Promise<void> | null = null;
  private readyTask: Promise<void> | null = null;
  private prepared = false;
  private closing: Promise<void> | null = null;
  private state: ConnectionStatus = {
    connected: false,
    loginFailures: 0,
    registrationFailures: 0,
    reconnects: 0,
    lastReadyAt: null,
    lastDisconnectAt: null,
    lastResumeAt: null,
  };
  constructor(
    private readonly adapter: DiscordAdapter,
    private readonly logger: typeof log = log,
    private readonly now: () => number = Date.now,
    private readonly pause: Wait = wait,
  ) {}
  status(): ConnectionStatus {
    return { ...this.state, connected: !this.abort.signal.aborted && this.adapter.isReady() };
  }
  start(): Promise<void> {
    this.loginTask ??= this.loginLoop();
    return this.loginTask;
  }
  private async retry(attempt: number): Promise<boolean> {
    if (this.abort.signal.aborted) return false;
    try {
      await this.pause(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)), this.abort.signal);
      return !this.abort.signal.aborted;
    } catch (error) {
      if (this.abort.signal.aborted) return false;
      throw error;
    }
  }
  private async loginLoop(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      try {
        await this.adapter.login();
        return;
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.state.loginFailures++;
        this.logger('discord_login_failed', { ...safeError(error), attempt: attempt + 1 });
        try {
          await this.adapter.destroy();
        } catch (failure) {
          this.logger('discord_reset_failed', safeError(failure));
        }
        if (!(await this.retry(attempt++))) return;
      }
    }
  }
  ready(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    this.state.connected = true;
    this.state.lastReadyAt = this.now();
    this.logger('discord_ready');
    if (this.prepared) return Promise.resolve();
    this.readyTask ??= this.prepareLoop().finally(() => {
      this.readyTask = null;
    });
    return this.readyTask;
  }
  private async prepareLoop(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted && this.adapter.isReady()) {
      try {
        await this.adapter.prepare();
        if (!this.abort.signal.aborted && this.adapter.isReady()) this.prepared = true;
        return;
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.state.registrationFailures++;
        this.logger('discord_setup_failed', { ...safeError(error), attempt: attempt + 1 });
        if (!(await this.retry(attempt++))) return;
      }
    }
  }
  disconnected(code: number, shard: number): void {
    this.state.connected = false;
    this.state.lastDisconnectAt = this.now();
    this.logger('discord_disconnected', { code, shard });
  }
  reconnecting(shard: number): void {
    this.state.reconnects++;
    this.logger('discord_reconnecting', { shard });
  }
  resumed(shard: number, replayed: number): void {
    this.state.lastResumeAt = this.now();
    this.logger('discord_resumed', { shard, replayed });
  }
  cancel(): void {
    this.abort.abort();
  }
  stop(): Promise<void> {
    this.cancel();
    this.closing ??= (async () => {
      await this.adapter.destroy();
      await Promise.allSettled([this.loginTask, this.readyTask]);
    })();
    return this.closing;
  }
}

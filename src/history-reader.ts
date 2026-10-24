import { Worker } from 'node:worker_threads';
import { HISTORY_WINDOWS, type HistorySummary } from './history.js';
import type { HistoryComparison, HistoryReader, QueryKind, QueryResult } from './history-query.js';

export const QUERY_CACHE_MS = 60_000;
interface Pending {
  key: string;
  requestedAt: number;
  promise: Promise<QueryResult>;
  resolve(value: QueryResult): void;
  reject(error: Error): void;
}
function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

/** One lazy read-only worker; at most twelve coalesced window queries and cached results. */
export class ArchiveReader implements HistoryReader {
  private worker: Worker | null = null;
  private stopping = false;
  private closing: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private cache = new Map<string, { at: number; result: QueryResult }>();
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}
  summary(minutes: number): Promise<HistorySummary> {
    return this.request('summary', minutes) as Promise<HistorySummary>;
  }
  compare(minutes: number): Promise<HistoryComparison> {
    return this.request('compare', minutes) as Promise<HistoryComparison>;
  }
  private request(kind: QueryKind, minutes: number): Promise<QueryResult> {
    if (this.stopping) return Promise.reject(namedError('ArchiveReaderClosed'));
    if (!(HISTORY_WINDOWS as readonly number[]).includes(minutes))
      return Promise.reject(namedError('UnsupportedHistoryWindow'));
    const now = this.now();
    const key = `${kind}:${minutes}`;
    const cached = this.cache.get(key);
    if (cached && now >= cached.at && now - cached.at < QUERY_CACHE_MS)
      return Promise.resolve(structuredClone(cached.result));
    for (const request of this.pending.values())
      if (request.key === key) return request.promise.then((value) => structuredClone(value));
    let resolve!: Pending['resolve'];
    let reject!: Pending['reject'];
    const promise = new Promise<QueryResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const id = ++this.sequence;
    this.pending.set(id, { key, requestedAt: now, promise, resolve, reject });
    try {
      this.getWorker().postMessage({ id, kind, minutes, now });
    } catch {
      this.fail(namedError('ArchiveReaderUnavailable'));
    }
    return promise.then((value) => structuredClone(value));
  }
  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./history-worker.js', import.meta.url), {
      workerData: { path: this.path },
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    this.worker = worker;
    worker.on(
      'message',
      (message: { id: number; result?: QueryResult; error?: Record<string, string | number> }) => {
        if (this.worker !== worker) return;
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.result) {
          this.cache.set(request.key, { at: request.requestedAt, result: message.result });
          request.resolve(message.result);
        } else request.reject(Object.assign(namedError('ArchiveQueryFailed'), message.error));
      },
    );
    worker.on('error', () => {
      if (this.worker === worker) this.fail(namedError('ArchiveReaderUnavailable'));
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.fail(namedError('ArchiveReaderUnavailable'));
    });
    return worker;
  }
  private fail(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    this.cache.clear();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    if (worker) worker.terminate().catch(() => {});
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    const worker = this.worker;
    this.worker = null;
    for (const request of this.pending.values()) request.reject(namedError('ArchiveReaderClosed'));
    this.pending.clear();
    this.cache.clear();
    this.closing = worker ? worker.terminate().then(() => {}) : Promise.resolve();
    return this.closing;
  }
}

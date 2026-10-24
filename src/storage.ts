import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HISTORY_LIMIT, isHistoryPoint, type HistoryPoint } from './history.js';

export const MAX_HISTORY_BYTES = 1024 * 1024;
export interface HistoryStorageStatus {
  healthy: boolean;
  lastSavedAt: number | null;
  metricCount?: number;
  commandCount?: number;
  firstAt?: number | null;
  recoveries?: number;
  pendingSamples?: number;
  auditFailures?: number;
  droppedSamples?: number;
}

function invalidFile(): Error {
  return Object.assign(new Error('History file is invalid or uses an unsupported format.'), {
    name: 'InvalidHistoryFile',
  });
}
function copyPoint({ at, cpu, memory, temperature }: HistoryPoint): HistoryPoint {
  return { at, cpu, memory, temperature };
}
function encode(points: readonly HistoryPoint[]): string {
  if (points.length > HISTORY_LIMIT || !points.every(isHistoryPoint)) throw invalidFile();
  const data = `${JSON.stringify({ version: 1, points: points.map(copyPoint) })}\n`;
  if (Buffer.byteLength(data) > MAX_HISTORY_BYTES) throw invalidFile();
  return data;
}

/** One writer per volume. All writes within this process are serialized. */
export class HistoryFileStore {
  private loaded = false;
  private healthy = false;
  private lastSavedAt: number | null = null;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  status(): HistoryStorageStatus {
    return { healthy: this.healthy, lastSavedAt: this.lastSavedAt };
  }

  async load(): Promise<HistoryPoint[]> {
    this.loaded = false;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      },
    );
    if (!file) {
      this.loaded = true;
      return [];
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_HISTORY_BYTES) throw invalidFile();
      // Read at most the cap plus one byte, even if a file grows after stat().
      const buffer = Buffer.alloc(MAX_HISTORY_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_HISTORY_BYTES) throw invalidFile();
      let decoded: unknown;
      try {
        decoded = JSON.parse(buffer.toString('utf8', 0, length));
      } catch {
        throw invalidFile();
      }
      if (typeof decoded !== 'object' || decoded === null) throw invalidFile();
      const data = decoded as Record<string, unknown>;
      if (
        data.version !== 1 ||
        !Array.isArray(data.points) ||
        data.points.length > HISTORY_LIMIT ||
        !data.points.every(isHistoryPoint)
      )
        throw invalidFile();
      this.loaded = true;
      return data.points.map(copyPoint);
    } finally {
      await file.close();
    }
  }

  async save(points: readonly HistoryPoint[]): Promise<void> {
    let data: string;
    try {
      if (!this.loaded)
        throw Object.assign(new Error('Load history before writing it.'), {
          name: 'HistoryNotLoaded',
        });
      data = encode(points);
    } catch (error) {
      this.healthy = false;
      throw error;
    }
    const operation = this.pending
      .then(async () => {
        await this.write(data);
        this.lastSavedAt = Date.now();
        this.healthy = true;
      })
      .catch((error: unknown) => {
        this.healthy = false;
        throw error;
      });
    this.pending = operation.catch(() => {});
    await operation;
  }

  private async write(data: string): Promise<void> {
    const temporary = `${this.path}.tmp`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.chmod(0o600);
      await file.writeFile(data, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // The temporary file is on the same filesystem as the destination.
    await rename(temporary, this.path);
    const directory = await open(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

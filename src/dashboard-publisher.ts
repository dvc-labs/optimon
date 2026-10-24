import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PUBLIC_HISTORY_MS,
  PUBLIC_SCHEMA,
  parsePublicData,
  parsePublicHistory,
  type PublicData,
  type PublicHistory,
} from './dashboard-data.js';
import type { Snapshot } from './metrics.js';
import { THERMAL_RECOVER_C, THERMAL_WARN_C } from './monitoring.js';
import { VERSION } from './version.js';

export interface SnapshotPublisher {
  publish(snapshot: Snapshot): Promise<void>;
}

export class DashboardPublisher implements SnapshotPublisher {
  private nextHistory = 0;
  constructor(
    private readonly directory: string,
    private readonly readHistory: () => Promise<PublicHistory>,
    private readonly now: () => number = Date.now,
  ) {}
  async publish(snapshot: Snapshot): Promise<void> {
    // Explicit selection is the privacy boundary. No Config, TelemetryStatus, audit or environment spread.
    const data: PublicData = parsePublicData({
      schema: PUBLIC_SCHEMA,
      version: VERSION,
      generatedAt: this.now(),
      thermalWarnC: THERMAL_WARN_C,
      thermalRecoverC: THERMAL_RECOVER_C,
      live: {
        capturedAt: snapshot.capturedAt.getTime(),
        hostUptime: snapshot.hostUptime,
        botUptime: snapshot.botUptime,
        cpuPercent: snapshot.cpuPercent,
        cores: snapshot.cores,
        memory: snapshot.memory
          ? {
              total: snapshot.memory.total,
              used: snapshot.memory.used,
              available: snapshot.memory.available,
              percent: snapshot.memory.percent,
            }
          : null,
        swap: snapshot.swap
          ? {
              total: snapshot.swap.total,
              used: snapshot.swap.used,
              available: snapshot.swap.free,
              percent: snapshot.swap.percent,
            }
          : null,
        load: snapshot.load,
        temperatures: snapshot.temperatures
          .filter((t) => /^(Package id \d+|Core \d+|temp\d+)$/.test(t.label))
          .map((t) => ({ label: t.label, celsius: t.celsius })),
      },
      history: null,
    });
    await this.write('metrics.json', data);
    if (this.now() >= this.nextHistory) {
      this.nextHistory = this.now() + PUBLIC_HISTORY_MS;
      // Publish live data first. A failed/slow archive query cannot hide a fresh host snapshot.
      const history = parsePublicHistory(await this.readHistory());
      await this.write('history.json', history);
    }
  }
  private async write(name: string, data: PublicData | PublicHistory): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o750 });
    const temporary = join(this.directory, `.metrics-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o640,
    );
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.close();
      // Ephemeral projection: atomic visibility, no fsync per minute; the SQLite archive stays durable.
      await rename(temporary, join(this.directory, name));
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => {});
    }
  }
}

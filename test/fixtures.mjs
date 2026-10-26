import { loadConfig } from '../dist/config.js';

export const ownerId = '1562643787510063218';
export function config(overrides = {}) {
  return loadConfig({
    DISCORD_TOKEN: 'fixture-token-never-send',
    APPLICATION_ID: '1562643787510063217',
    GUILD_ID: '1562082957022204006',
    CHANNEL_ID: '1562960345860153444',
    ADMIN_ID: ownerId,
    ...overrides,
  });
}

export function snapshot(overrides = {}) {
  return {
    capturedAt: new Date('2026-10-24T12:00:00Z'),
    hostUptime: 90000,
    botUptime: 30,
    bootTime: new Date('2026-10-23T11:00:00Z').getTime(),
    runnableTasks: 1,
    cpuDetails: { iowaitPercent: 0.5, stealPercent: 0, perCore: [{ id: 0, percent: 5 }] },
    memoryBreakdown: {
      free: 6 * 1024 ** 3,
      cached: 512 * 1024 ** 2,
      buffers: 1024 ** 2,
      slab: 100 * 1024 ** 2,
      reclaimableSlab: 20 * 1024 ** 2,
      unreclaimableSlab: 80 * 1024 ** 2,
      kernelStack: 1024 ** 2,
      pageTables: 1024 ** 2,
    },
    disk: null,
    cpuPercent: 5,
    cores: 6,
    memory: { total: 8 * 1024 ** 3, used: 1024 ** 3, available: 7 * 1024 ** 3, percent: 12.5 },
    swap: { total: 4 * 1024 ** 3, free: 4 * 1024 ** 3, used: 0, percent: 0 },
    load: [0.1, 0.2, 0.3],
    temperatures: [{ label: 'Package id 0', celsius: 31 }],
    unavailable: [],
    ...overrides,
  };
}

export function telemetryStatus(overrides = {}) {
  return {
    healthy: true,
    lastSavedAt: Date.now(),
    metricCount: 100,
    commandCount: 0,
    firstAt: null,
    recoveries: 0,
    pendingSamples: 0,
    auditFailures: 0,
    droppedSamples: 0,
    ...overrides,
  };
}
export function historySummary(overrides = {}) {
  const at = snapshot().capturedAt.getTime();
  const metric = { count: 1, min: 5, mean: 5, max: 5, graph: '▁'.repeat(24) };
  return {
    minutes: 1440,
    count: 1,
    firstAt: at,
    lastAt: at,
    cpu: { ...metric },
    memory: { ...metric },
    temperature: { ...metric },
    ...overrides,
  };
}

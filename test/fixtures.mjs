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

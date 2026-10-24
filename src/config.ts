import { isAbsolute, resolve } from 'node:path';

export interface Config {
  token: string;
  applicationId: string;
  guildId: string;
  channelId: string;
  adminId: string | null;
  thermalAlerts: boolean;
  hostName: string;
  intervalMinutes: number;
  auditRetentionDays: number;
  procPath: string;
  sensorPath: string;
  historyFile: string;
  databaseFile: string;
  heartbeatUrl: string | null;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}.`);
  return value;
}

function snowflake(value: string, key: string): string {
  if (
    !/^\d{17,20}$/.test(value) ||
    BigInt(value) === 0n ||
    BigInt(value) > 18_446_744_073_709_551_615n
  ) {
    throw new Error(`${key} must be a Discord ID stored as a string.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const applicationId = env.APPLICATION_ID?.trim() || required(env, 'CLIENT_ID');
  if (
    env.APPLICATION_ID?.trim() &&
    env.CLIENT_ID?.trim() &&
    env.APPLICATION_ID.trim() !== env.CLIENT_ID.trim()
  ) {
    throw new Error('APPLICATION_ID and CLIENT_ID must match; only APPLICATION_ID is needed.');
  }
  const interval = env.STATS_INTERVAL_MINUTES?.trim() || '30';
  if (!/^\d+$/.test(interval) || Number(interval) < 1 || Number(interval) > 1440) {
    throw new Error('STATS_INTERVAL_MINUTES must be an integer from 1 to 1440.');
  }
  const retention = env.AUDIT_RETENTION_DAYS?.trim() || '90';
  if (!/^\d+$/.test(retention) || Number(retention) > 3650)
    throw new Error(
      'AUDIT_RETENTION_DAYS must be an integer from 0 to 3650 (0 keeps all records).',
    );
  const alerts = env.THERMAL_ALERTS_ENABLED?.trim().toLowerCase() || 'true';
  if (alerts !== 'true' && alerts !== 'false') {
    throw new Error('THERMAL_ALERTS_ENABLED must be true or false.');
  }
  const hostName = env.HOST_NAME?.trim() || 'optiplex';
  if (hostName.length > 64 || !/^[A-Za-z0-9 ._-]+$/.test(hostName)) {
    throw new Error(
      'HOST_NAME must contain at most 64 letters, numbers, spaces, dots, underscores or hyphens.',
    );
  }
  const procPath = env.HOST_PROC_PATH || '/host-metrics/proc';
  const sensorPath = env.TEMP_SENSOR_PATH || '/host-metrics/hwmon';
  if (!isAbsolute(procPath) || !isAbsolute(sensorPath)) {
    throw new Error('Metric paths must be absolute paths.');
  }
  const historyFile = env.HISTORY_FILE?.trim() || resolve('data/history.json');
  if (!isAbsolute(historyFile)) throw new Error('HISTORY_FILE must be an absolute path.');
  const databaseFile = env.DATABASE_FILE?.trim() || resolve('data/optiplex.sqlite');
  if (!isAbsolute(databaseFile) || databaseFile === historyFile)
    throw new Error('DATABASE_FILE must be an absolute path different from HISTORY_FILE.');
  const heartbeatUrl = env.HEARTBEAT_URL?.trim() || null;
  if (heartbeatUrl) {
    try {
      const url = new URL(heartbeatUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    } catch {
      throw new Error('HEARTBEAT_URL must be an HTTPS URL without user information or a fragment.');
    }
  }
  return {
    token: required(env, 'DISCORD_TOKEN'),
    applicationId: snowflake(applicationId, 'APPLICATION_ID'),
    guildId: snowflake(required(env, 'GUILD_ID'), 'GUILD_ID'),
    channelId: snowflake(required(env, 'CHANNEL_ID'), 'CHANNEL_ID'),
    adminId: env.ADMIN_ID?.trim() ? snowflake(env.ADMIN_ID.trim(), 'ADMIN_ID') : null,
    thermalAlerts: alerts === 'true',
    hostName,
    intervalMinutes: Number(interval),
    auditRetentionDays: Number(retention),
    procPath,
    sensorPath,
    historyFile,
    databaseFile,
    heartbeatUrl,
  };
}

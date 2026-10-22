import { isAbsolute } from 'node:path';

export interface Config {
  token: string;
  applicationId: string;
  guildId: string;
  channelId: string;
  webhookUrl: string | null;
  hostName: string;
  intervalMinutes: number;
  procPath: string;
  sensorPath: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}.`);
  return value;
}

function snowflake(value: string, key: string): string {
  if (!/^\d{17,20}$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new Error(`${key} must be a Discord ID stored as a string.`);
  }
  return value;
}

export function validateWebhookUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('WEBHOOK_URL must be a Discord webhook URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port ||
      url.username || url.password || url.hash || url.search ||
      !/^\/api\/(?:v\d+\/)?webhooks\/\d{17,20}\/[A-Za-z0-9_-]{20,}$/.test(url.pathname)) {
    throw new Error('WEBHOOK_URL must be an HTTPS discord.com webhook URL without query parameters.');
  }
  return url.href;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const applicationId = env.APPLICATION_ID?.trim() || required(env, 'CLIENT_ID');
  if (env.APPLICATION_ID?.trim() && env.CLIENT_ID?.trim() &&
      env.APPLICATION_ID.trim() !== env.CLIENT_ID.trim()) {
    throw new Error('APPLICATION_ID and CLIENT_ID must match; only APPLICATION_ID is needed.');
  }
  const interval = env.STATS_INTERVAL_MINUTES?.trim() || '15';
  if (!/^\d+$/.test(interval) || Number(interval) < 1 || Number(interval) > 1440) {
    throw new Error('STATS_INTERVAL_MINUTES must be an integer from 1 to 1440.');
  }
  const hostName = env.HOST_NAME?.trim() || 'optiplex';
  if (hostName.length > 64 || !/^[A-Za-z0-9 ._-]+$/.test(hostName)) {
    throw new Error('HOST_NAME must contain at most 64 letters, numbers, spaces, dots, underscores or hyphens.');
  }
  const procPath = env.HOST_PROC_PATH || '/host-metrics/proc';
  const sensorPath = env.TEMP_SENSOR_PATH || '/host-metrics/hwmon';
  if (!isAbsolute(procPath) || !isAbsolute(sensorPath)) {
    throw new Error('Metric paths must be absolute paths.');
  }
  return {
    token: required(env, 'DISCORD_TOKEN'),
    applicationId: snowflake(applicationId, 'APPLICATION_ID'),
    guildId: snowflake(required(env, 'GUILD_ID'), 'GUILD_ID'),
    channelId: snowflake(required(env, 'CHANNEL_ID'), 'CHANNEL_ID'),
    webhookUrl: env.WEBHOOK_URL?.trim() ? validateWebhookUrl(env.WEBHOOK_URL.trim()) : null,
    hostName,
    intervalMinutes: Number(interval),
    procPath,
    sensorPath,
  };
}

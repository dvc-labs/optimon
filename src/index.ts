import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { registerCommands } from './commands.js';
import { HEALTH_PATH } from './health.js';
import { log, safeError } from './log.js';
import { collectSnapshot } from './metrics.js';
import { BotReporter } from './reporter.js';
import { MonitorRuntime } from './runtime.js';
import { TelemetryStore } from './telemetry.js';
import { ArchiveReader } from './history-reader.js';
import { DashboardPublisher } from './dashboard-publisher.js';

if (existsSync('.env')) loadEnvFile('.env');
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  log('configuration_error', {
    reason: error instanceof Error ? error.message : 'Invalid configuration.',
  });
  process.exit(1);
}
let telemetry: TelemetryStore;
try {
  telemetry = await TelemetryStore.open(config.databaseFile, config.historyFile, (event) =>
    log(event),
  );
  try {
    const removed = telemetry.pruneCommands(config.auditRetentionDays);
    if (removed) log('audit_records_expired', { records: removed });
  } catch (error) {
    log('audit_retention_failed', safeError(error));
  }
  log('telemetry_opened', { ...telemetry.status() });
} catch (error) {
  log('telemetry_initialization_failed', safeError(error));
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
  rest: { timeout: 15_000, retries: 2 },
});
const archive = new ArchiveReader(config.databaseFile);
const runtime = new MonitorRuntime(config, {
  telemetry,
  archive,
  ...(config.publicDataPath
    ? { publisher: new DashboardPublisher(config.publicDataPath, () => archive.dashboard()) }
    : {}),
  reporter: new BotReporter(client, config),
  collect: () => collectSnapshot(config.procPath, config.sensorPath),
  gateway: {
    applicationId: () => client.application?.id ?? '',
    isReady: () => client.isReady(),
    ping: () => client.ws.ping,
    register: async () => {
      if (!client.application) throw new Error('Application is unavailable.');
      await registerCommands(client.application.commands, config.guildId);
    },
    activity: (text) => {
      client.user?.setActivity(text, { type: ActivityType.Watching });
    },
    destroy: () => client.destroy(),
  },
});
let shuttingDown = false;
function heartbeat(): void {
  try {
    writeFileSync(
      `${HEALTH_PATH}.tmp`,
      JSON.stringify({ ready: runtime.ready, updatedAt: Date.now() }),
      { mode: 0o600 },
    );
    renameSync(`${HEALTH_PATH}.tmp`, HEALTH_PATH);
  } catch (error) {
    log('health_write_failed', safeError(error));
  }
}
const healthTimer = setInterval(heartbeat, 15_000);
healthTimer.unref();
heartbeat();
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(healthTimer);
  log('shutdown', { code });
  const deadline = setTimeout(() => process.exit(code), 15_000);
  try {
    const stopped = runtime.stop();
    heartbeat();
    await stopped;
  } catch (error) {
    log('shutdown_failed', safeError(error));
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}
function stopAfterError(event: string, error: unknown): void {
  log(event, safeError(error));
  shutdown(1).catch((failure: unknown) => {
    log('fatal_shutdown_failed', safeError(failure));
    process.exit(1);
  });
}
client.once(Events.ClientReady, () => {
  runtime.start().catch((error: unknown) => stopAfterError('initialization_failed', error));
});
client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand())
    runtime
      .dispatch(interaction)
      .catch((error: unknown) => log('interaction_dispatch_failed', safeError(error)));
});
client.on(Events.Error, (error) => log('discord_client_error', safeError(error)));
client.on(Events.ShardError, (error) => log('discord_gateway_error', safeError(error)));
process.once('SIGTERM', () => {
  shutdown(0).catch((error: unknown) => stopAfterError('shutdown_failed', error));
});
process.once('SIGINT', () => {
  shutdown(0).catch((error: unknown) => stopAfterError('shutdown_failed', error));
});
process.once('uncaughtException', (error) => stopAfterError('uncaught_exception', error));
process.once('unhandledRejection', (error: unknown) =>
  stopAfterError('unhandled_rejection', error),
);
client.login(config.token).catch((error: unknown) => stopAfterError('login_failed', error));

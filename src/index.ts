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
import { DiscordConnection, DiscordClientSlot } from './discord-connection.js';

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

const clients = new DiscordClientSlot(
  () =>
    new Client({
      intents: [GatewayIntentBits.Guilds],
      allowedMentions: { parse: [] },
      rest: { timeout: 15_000, retries: 2 },
    }),
  attachClient,
);
const archive = new ArchiveReader(config.databaseFile);
const runtime = new MonitorRuntime(config, {
  telemetry,
  archive,
  ...(config.publicDataPath
    ? { publisher: new DashboardPublisher(config.publicDataPath, () => archive.dashboard()) }
    : {}),
  reporter: new BotReporter(() => clients.current, config),
  collect: () => collectSnapshot(config.procPath, config.sensorPath, config.diskPath),
  connectionStatus: () => connection.status(),
  gateway: {
    applicationId: () => clients.current.application?.id ?? '',
    isReady: () => clients.current.isReady(),
    ping: () => clients.current.ws.ping,
    register: async () => {
      if (!clients.current.application) throw new Error('Application is unavailable.');
      await registerCommands(clients.current.application.commands, config.guildId);
    },
    activity: (text) => {
      clients.current.user?.setActivity(text, { type: ActivityType.Watching });
    },
    destroy: () => connection.stop(),
  },
});
const connection = new DiscordConnection({
  login: () => clients.login(config.token),
  destroy: () => clients.destroy(),
  isReady: () => clients.current.isReady(),
  prepare: () => runtime.discordReady(),
});
let shuttingDown = false;
function heartbeat(): void {
  try {
    writeFileSync(
      `${HEALTH_PATH}.tmp`,
      JSON.stringify({
        ready: runtime.healthy,
        discordReady: runtime.ready,
        updatedAt: Date.now(),
      }),
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
  connection.cancel();
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
function attachClient(client: Client): void {
  const current = (): boolean => client === clients.current && !shuttingDown;
  client.on(Events.ClientReady, () => {
    if (current())
      connection
        .ready()
        .catch((error: unknown) => log('discord_setup_retry_failed', safeError(error)));
  });
  client.on(Events.ShardDisconnect, (event, shard) => {
    if (current()) connection.disconnected(event.code, shard);
  });
  client.on(Events.ShardReconnecting, (shard) => {
    if (current()) connection.reconnecting(shard);
  });
  client.on(Events.ShardResume, (shard, replayed) => {
    if (current()) connection.resumed(shard, replayed);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (current() && interaction.isChatInputCommand())
      runtime
        .dispatch(interaction)
        .catch((error: unknown) => log('interaction_dispatch_failed', safeError(error)));
  });
  client.on(Events.Error, (error) => {
    if (current()) log('discord_client_error', safeError(error));
  });
  client.on(Events.ShardError, (error) => {
    if (current()) log('discord_gateway_error', safeError(error));
  });
}
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
runtime
  .start()
  .then(heartbeat)
  .catch((error: unknown) => stopAfterError('monitor_initialization_failed', error));
connection.start().catch((error: unknown) => stopAfterError('discord_retry_failed', error));

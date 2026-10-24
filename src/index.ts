import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import {
  ActivityType, Client, Events, GatewayIntentBits, MessageFlags,
} from 'discord.js';
import { loadConfig } from './config.js';
import { baseEmbed, statsEmbed, thermalEmbed } from './embeds.js';
import { commandDefinitions, handleCommand, type CommandContext } from './commands.js';
import { Cooldown, ReportControls } from './controls.js';
import { History } from './history.js';
import { HEALTH_PATH } from './health.js';
import { log, safeError } from './log.js';
import { collectSnapshot, hottestTemperature } from './metrics.js';
import { MetricsCache, SAMPLE_INTERVAL_MS, ThermalWatch } from './monitoring.js';
import { BotReporter } from './reporter.js';
import { scheduleReports } from './scheduler.js';
import { VERSION } from './version.js';

// Local convenience only: Docker excludes .env and receives runtime variables from Coolify.
if (existsSync('.env')) loadEnvFile('.env');
let config: ReturnType<typeof loadConfig>;
try { config = loadConfig(); } catch (error) {
  // Configuration errors originate here and name settings, never their values.
  log('configuration_error', { reason: error instanceof Error ? error.message : 'Invalid configuration.' });
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] },
  rest: { timeout: 15_000, retries: 2 },
});
const reporter = new BotReporter(client, config);
const reports = new ReportControls();
const history = new History();
const thermal = new ThermalWatch();
const cache = new MetricsCache(async () => {
  const snapshot = await collectSnapshot(config.procPath, config.sensorPath);
  if (snapshot.unavailable.length) log('metrics_unavailable', { readings: snapshot.unavailable });
  return snapshot;
});
const commandContext: CommandContext = {
  config, cache, history, reports, reporter, cooldown: new Cooldown(10_000),
  manualCooldown: new Cooldown(60_000, 1), gatewayPing: () => client.ws.ping,
};
let initialized = false;
let shuttingDown = false;
let stopReports: (() => void) | null = null;
let stopSamples: (() => void) | null = null;

async function sample(): Promise<void> {
  const snapshot = await cache.getSnapshot();
  if (shuttingDown) return;
  history.record(snapshot);
  if (client.isReady()) {
    const temperature = hottestTemperature(snapshot);
    const readings = [temperature === null ? null : `${temperature.toFixed(0)} °C`,
      snapshot.cpuPercent === null ? null : `CPU ${snapshot.cpuPercent.toFixed(0)}%`,
      snapshot.memory === null ? null : `RAM ${snapshot.memory.percent.toFixed(0)}%`].filter(Boolean);
    client.user.setActivity(`${config.hostName} · ${readings.join(' · ') || 'readings unavailable'}`.slice(0, 128),
      { type: ActivityType.Watching });
  }
  if (config.thermalAlerts) {
    const event = thermal.observe(snapshot);
    if (event && client.isReady()) {
      await reporter.send(thermalEmbed(event, snapshot));
      thermal.confirm(event);
      log('thermal_notification_sent', { state: event });
    }
  }
}

function heartbeat(): void {
  try {
    writeFileSync(`${HEALTH_PATH}.tmp`, JSON.stringify({
      ready: initialized && client.isReady() && !shuttingDown, updatedAt: Date.now(),
    }), { mode: 0o600 });
    renameSync(`${HEALTH_PATH}.tmp`, HEALTH_PATH);
  } catch (error) { log('health_write_failed', safeError(error)); }
}
const healthTimer = setInterval(heartbeat, 15_000);
healthTimer.unref();
heartbeat();

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown', { code });
  stopReports?.();
  stopSamples?.();
  clearInterval(healthTimer);
  heartbeat();
  const deadline = setTimeout(() => process.exit(code), 5000);
  deadline.unref();
  await client.destroy();
  process.exit(code);
}

client.once(Events.ClientReady, (ready) => {
  void (async () => {
    if (ready.application.id !== config.applicationId) {
      log('application_id_mismatch');
      await shutdown(1);
      return;
    }
    // Upsert our commands in this guild; preserve any other application commands.
    for (const command of commandDefinitions()) {
      await ready.application.commands.create(command.toJSON(), config.guildId);
    }
    if (shuttingDown) return;
    initialized = true;
    heartbeat();
    log('ready', { version: VERSION, host: config.hostName, reportIntervalMinutes: config.intervalMinutes,
      ownerControlsEnabled: config.adminId !== null, thermalAlertsEnabled: config.thermalAlerts });
    await sample();
    if (shuttingDown) return;
    stopSamples = scheduleReports(sample, SAMPLE_INTERVAL_MS,
      (error) => log('monitor_sample_failed', safeError(error)));
    try {
      const snapshot = await cache.getSnapshot();
      if (!shuttingDown) {
        await reporter.send(statsEmbed(snapshot, config, true));
        reports.lastReportAt = Date.now();
      }
    } catch (error) { reports.failures++; log('startup_notification_failed', safeError(error)); }
    if (!shuttingDown) {
      stopReports = scheduleReports(async () => {
        if (reports.isPaused()) { log('scheduled_report_paused'); return; }
        const snapshot = await cache.getSnapshot();
        if (!shuttingDown && !reports.isPaused()) {
          await reporter.send(statsEmbed(snapshot, config));
          reports.lastReportAt = Date.now();
          log('stats_report_sent');
        }
      }, config.intervalMinutes * 60_000, (error) => {
        reports.failures++; log('stats_report_failed', safeError(error));
      });
    }
  })().catch((error: unknown) => {
    log('initialization_failed', safeError(error));
    void shutdown(1);
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  void handleCommand(interaction, commandContext).catch(async (error: unknown) => {
    log('interaction_failed', safeError(error));
    const payload = { embeds: [baseEmbed('Optiplex · Command failed')
      .setDescription('Please try again later. The owner can check the bot logs for a safe error identifier.')],
    allowedMentions: { parse: [] as [] } };
    try {
      if (interaction.deferred) await interaction.editReply(payload);
      else if (!interaction.replied) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (replyError) { log('interaction_response_failed', safeError(replyError)); }
  });
});

client.on(Events.Error, (error) => log('discord_client_error', safeError(error)));
client.on(Events.ShardError, (error) => log('discord_gateway_error', safeError(error)));
process.once('SIGTERM', () => { void shutdown(0); });
process.once('SIGINT', () => { void shutdown(0); });
process.once('uncaughtException', (error) => {
  log('uncaught_exception', safeError(error));
  void shutdown(1);
});
process.once('unhandledRejection', (error: unknown) => {
  log('unhandled_rejection', safeError(error));
  void shutdown(1);
});
void client.login(config.token).catch((error: unknown) => {
  log('login_failed', safeError(error));
  void shutdown(1);
});

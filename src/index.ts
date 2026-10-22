import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import {
  ActivityType, Client, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { loadConfig } from './config.js';
import { aboutEmbed, baseEmbed, statsEmbed } from './embeds.js';
import { HEALTH_PATH } from './health.js';
import { log, safeError } from './log.js';
import { collectSnapshot } from './metrics.js';
import { scheduleReports } from './scheduler.js';
import { VERSION } from './version.js';
import { WebhookReporter } from './webhook.js';

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
const reporter = config.webhookUrl ? new WebhookReporter(config) : null;
let initialized = false;
let shuttingDown = false;
let stopReports: (() => void) | null = null;

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
  clearInterval(healthTimer);
  heartbeat();
  const deadline = setTimeout(() => process.exit(code), 5000);
  deadline.unref();
  reporter?.destroy();
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
    const command = new SlashCommandBuilder().setName('about')
      .setDescription('About the Optiplex monitoring bot and its current version.');
    // Upsert only /about in this guild; do not bulk-delete other commands.
    await ready.application.commands.create(command.toJSON(), config.guildId);
    ready.user.setActivity(config.hostName, { type: ActivityType.Watching });
    initialized = true;
    heartbeat();
    log('ready', { version: VERSION, host: config.hostName, reportsEnabled: reporter !== null });
    try {
      const channel = await ready.channels.fetch(config.channelId);
      if (!channel || !channel.isSendable() || channel.isDMBased() || channel.guildId !== config.guildId) {
        throw Object.assign(new Error('Invalid notification channel.'), { name: 'NotificationChannelMismatch' });
      }
      const snapshot = await collectSnapshot(config.procPath, config.sensorPath);
      if (snapshot.unavailable.length) log('metrics_unavailable', { readings: snapshot.unavailable });
      await channel.send({ embeds: [statsEmbed(snapshot, config, true)], allowedMentions: { parse: [] } });
    } catch (error) { log('startup_notification_failed', safeError(error)); }
    if (reporter && !shuttingDown) {
      stopReports = scheduleReports(async () => {
        const snapshot = await collectSnapshot(config.procPath, config.sensorPath);
        if (snapshot.unavailable.length) log('metrics_unavailable', { readings: snapshot.unavailable });
        if (!shuttingDown) {
          await reporter.send(statsEmbed(snapshot, config));
          log('stats_report_sent');
        }
      }, config.intervalMinutes * 60_000, (error) => log('stats_report_failed', safeError(error)));
    }
  })().catch((error: unknown) => {
    log('initialization_failed', safeError(error));
    void shutdown(1);
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'about') return;
  void (async () => {
    if (interaction.guildId !== config.guildId) {
      await interaction.reply({
        embeds: [baseEmbed('Unavailable here').setDescription('This bot is configured for a different server.')],
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.reply({ embeds: [aboutEmbed(config)], allowedMentions: { parse: [] } });
  })().catch((error: unknown) => log('interaction_failed', safeError(error)));
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

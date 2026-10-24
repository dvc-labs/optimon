import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from './config.js';
import { Cooldown, type ReportControls } from './controls.js';
import { aboutEmbed, baseEmbed, diagnosticsEmbed, helpEmbed, historyEmbed, pingEmbed,
  statsEmbed, uptimeEmbed, vibeEmbed } from './embeds.js';
import type { History } from './history.js';
import type { MetricsCache } from './monitoring.js';
import type { BotReporter } from './reporter.js';

export function commandDefinitions(): SlashCommandBuilder[] {
  const monitor = new SlashCommandBuilder().setName('optiplex').setDescription('Explore the home server.');
  for (const [name, description] of [
    ['stats', 'Current host CPU, RAM, swap and temperatures.'],
    ['uptime', 'Host and bot uptimes, with estimated start times.'],
    ['ping', 'Measure this bot’s connection to Discord.'],
    ['vibe', 'Ask how the tiny Dell is feeling.'],
    ['help', 'Commands, sampling and owner controls.'],
  ]) monitor.addSubcommand((sub) => sub.setName(name!).setDescription(description!));
  monitor.addSubcommand((sub) => sub.setName('history').setDescription('Sampled trends since this bot started.')
    .addIntegerOption((option) => option.setName('hours').setDescription('Time window (default: 1 hour).')
      .addChoices({ name: 'Last hour', value: 1 }, { name: 'Last 6 hours', value: 6 }, { name: 'Last 24 hours', value: 24 })));
  const admin = new SlashCommandBuilder().setName('optiplex-admin')
    .setDescription('Owner controls for the monitor.').setDefaultMemberPermissions(0);
  admin.addSubcommand((sub) => sub.setName('diagnostics').setDescription('Private bot resource and reporting diagnostics.'));
  admin.addSubcommand((sub) => sub.setName('snapshot').setDescription('Post a snapshot to the configured reporting channel.'));
  admin.addSubcommand((sub) => sub.setName('pause').setDescription('Temporarily pause scheduled reports; thermal alerts continue.')
    .addIntegerOption((option) => option.setName('minutes').setDescription('5–1440 minutes (default: 60).')
      .setMinValue(5).setMaxValue(1440)));
  admin.addSubcommand((sub) => sub.setName('resume').setDescription('Resume scheduled reports at their usual cadence.'));
  return [new SlashCommandBuilder().setName('about').setDescription('About the Optiplex bot and its version.'), monitor, admin];
}

export interface CommandContext {
  config: Config; cache: MetricsCache; history: History; reports: ReportControls;
  reporter: BotReporter; cooldown: Cooldown; manualCooldown: Cooldown;
  gatewayPing: () => number;
}

export async function handleCommand(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<boolean> {
  const { config, cache, history, reports, reporter } = context;
  if (!['about', 'optiplex', 'optiplex-admin'].includes(interaction.commandName)) return false;
  async function deny(title: string, description: string): Promise<boolean> {
    await interaction.reply({ embeds: [baseEmbed(title).setDescription(description)],
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  if (interaction.guildId !== config.guildId) return deny('Unavailable here', 'This bot is configured for a different server.');
  const admin = interaction.commandName === 'optiplex-admin';
  // User-ID authorization is mandatory even if Discord grants Administrator or a command override.
  if (admin && (!config.adminId || interaction.user.id !== config.adminId)) {
    return deny('Owner controls', config.adminId ? 'This command is reserved for the configured bot owner.'
      : 'Owner controls are disabled until ADMIN_ID is configured.');
  }
  const wait = context.cooldown.take(interaction.user.id);
  if (wait) return deny('One moment', `Try again in ${Math.ceil(wait / 1000)} seconds.`);
  const started = performance.now();
  await interaction.deferReply(admin ? { flags: MessageFlags.Ephemeral } : {});
  const acknowledgementMs = performance.now() - started;
  const edit = async (embed: ReturnType<typeof baseEmbed>): Promise<boolean> => {
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  };
  if (interaction.commandName === 'about') return edit(aboutEmbed(config, reports.status()));
  const sub = interaction.options.getSubcommand();
  if (!admin) {
    if (sub === 'help') return edit(helpEmbed());
    if (sub === 'ping') return edit(pingEmbed(context.gatewayPing(), acknowledgementMs));
    if (sub === 'history') return edit(historyEmbed(history.summary((interaction.options.getInteger('hours') ?? 1) * 60)));
    const snapshot = await cache.getSnapshot();
    if (sub === 'stats') return edit(statsEmbed(snapshot, config));
    if (sub === 'uptime') return edit(uptimeEmbed(snapshot, config));
    if (sub === 'vibe') return edit(vibeEmbed(snapshot));
  } else {
    if (sub === 'pause') {
      const until = reports.pause(interaction.options.getInteger('minutes') ?? 60);
      return edit(baseEmbed('Optiplex · Scheduled reports paused')
        .setDescription(`Paused until <t:${Math.floor(until / 1000)}:F>.\nSensor sampling and thermal alerts continue. A bot restart clears the pause.`));
    }
    if (sub === 'resume') {
      reports.resume();
      return edit(baseEmbed('Optiplex · Scheduled reports resumed')
        .setDescription(`Reports will post at the next regular ${config.intervalMinutes}-minute tick. Use the snapshot command for a post now.`));
    }
    if (sub === 'diagnostics') {
      const snapshot = await cache.getSnapshot();
      const memory = process.memoryUsage();
      return edit(diagnosticsEmbed(snapshot, config, { rss: memory.rss, heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal, gatewayMs: context.gatewayPing(), historySize: history.size,
        reports: reports.status(), now: Date.now() }));
    }
    if (sub === 'snapshot') {
      const remaining = context.manualCooldown.take('snapshot');
      if (remaining) return edit(baseEmbed('Optiplex · Snapshot cooldown')
        .setDescription(`Try again in ${Math.ceil(remaining / 1000)} seconds.`));
      try {
        await reporter.send(statsEmbed(await cache.getSnapshot(), config));
        reports.lastReportAt = Date.now();
      } catch (error) { reports.failures++; throw error; }
      return edit(baseEmbed('Optiplex · Snapshot posted').setDescription(`Sent to <#${config.channelId}>.`));
    }
  }
  return edit(baseEmbed('Command unavailable').setDescription('Please reopen the command picker to refresh the available commands.'));
}

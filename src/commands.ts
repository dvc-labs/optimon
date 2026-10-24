import { ApplicationCommandType, MessageFlags, SlashCommandBuilder,
  type ApplicationCommandManager, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from './config.js';
import { Cooldown, type ReportControls } from './controls.js';
import { aboutEmbed, baseEmbed, diagnosticsEmbed, helpEmbed, historyEmbed, pingEmbed,
  statsEmbed, uptimeEmbed, vibeEmbed } from './embeds.js';
import type { History } from './history.js';
import type { MetricsCache } from './monitoring.js';
import type { BotReporter } from './reporter.js';

const PUBLIC_COMMANDS = [
  ['about', 'About the Optiplex bot and its version.'],
  ['stats', 'Current host CPU, RAM, swap and temperatures.'],
  ['uptime', 'Host and bot uptimes, with estimated start times.'],
  ['history', 'Sampled trends since this bot started.'],
  ['ping', 'Measure this bot’s connection to Discord.'],
  ['vibe', 'Ask how the tiny Dell is feeling.'],
  ['help', 'Commands, sampling and owner controls.'],
] as const;
const OWNER_COMMANDS = [
  ['diagnostics', 'Private bot resource and reporting diagnostics.'],
  ['snapshot', 'Post a snapshot to the configured reporting channel.'],
  ['pause', 'Temporarily pause scheduled reports; thermal alerts continue.'],
  ['resume', 'Resume scheduled reports at their usual cadence.'],
] as const;
const ownerNames = new Set<string>(OWNER_COMMANDS.map(([name]) => name));
const commandNames = new Set<string>([...PUBLIC_COMMANDS, ...OWNER_COMMANDS].map(([name]) => name));
const legacyNames = new Set(['optiplex', 'optiplex-admin']);

export function commandDefinitions(): SlashCommandBuilder[] {
  return [...PUBLIC_COMMANDS, ...OWNER_COMMANDS].map(([name, description]) => {
    const command = new SlashCommandBuilder().setName(name).setDescription(description);
    if (ownerNames.has(name)) command.setDefaultMemberPermissions(0);
    if (name === 'history') command.addIntegerOption((option) => option.setName('hours')
      .setDescription('Time window (default: 1 hour).')
      .addChoices({ name: 'Last hour', value: 1 }, { name: 'Last 6 hours', value: 6 }, { name: 'Last 24 hours', value: 24 }));
    if (name === 'pause') command.addIntegerOption((option) => option.setName('minutes')
      .setDescription('5–1440 minutes (default: 60).').setMinValue(5).setMaxValue(1440));
    return command;
  });
}

export async function registerCommands(manager: ApplicationCommandManager, guildId: string): Promise<void> {
  for (const command of commandDefinitions()) await manager.create(command.toJSON(), guildId);
  // Retire only our old slash-command groups after all replacements are registered.
  // Fetching through this application manager scopes cleanup to this bot and guild.
  const registered = await manager.fetch({ guildId });
  for (const command of registered.values()) {
    if (command.type === ApplicationCommandType.ChatInput && legacyNames.has(command.name)) {
      await manager.delete(command.id, guildId);
    }
  }
}

export interface CommandContext {
  config: Config; cache: MetricsCache; history: History; reports: ReportControls;
  reporter: BotReporter; cooldown: Cooldown; manualCooldown: Cooldown;
  gatewayPing: () => number;
}

export async function handleCommand(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<boolean> {
  const { config, cache, history, reports, reporter } = context;
  const name = interaction.commandName;
  if (!commandNames.has(name)) return false;
  async function deny(title: string, description: string): Promise<boolean> {
    await interaction.reply({ embeds: [baseEmbed(title).setDescription(description)],
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  if (interaction.guildId !== config.guildId) return deny('Unavailable here', 'This bot is configured for a different server.');
  const admin = ownerNames.has(name);
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
  if (name === 'about') return edit(aboutEmbed(config, reports.status()));
  if (!admin) {
    if (name === 'help') return edit(helpEmbed());
    if (name === 'ping') return edit(pingEmbed(context.gatewayPing(), acknowledgementMs));
    if (name === 'history') return edit(historyEmbed(history.summary((interaction.options.getInteger('hours') ?? 1) * 60)));
    const snapshot = await cache.getSnapshot();
    if (name === 'stats') return edit(statsEmbed(snapshot, config));
    if (name === 'uptime') return edit(uptimeEmbed(snapshot, config));
    if (name === 'vibe') return edit(vibeEmbed(snapshot));
  } else {
    if (name === 'pause') {
      const until = reports.pause(interaction.options.getInteger('minutes') ?? 60);
      return edit(baseEmbed('Optiplex · Scheduled reports paused')
        .setDescription(`Paused until <t:${Math.floor(until / 1000)}:F>.\nSensor sampling and thermal alerts continue. A bot restart clears the pause.`));
    }
    if (name === 'resume') {
      reports.resume();
      return edit(baseEmbed('Optiplex · Scheduled reports resumed')
        .setDescription(`Reports will post at the next regular ${config.intervalMinutes}-minute tick. Use \`/snapshot\` for a post now.`));
    }
    if (name === 'diagnostics') {
      const snapshot = await cache.getSnapshot();
      const memory = process.memoryUsage();
      return edit(diagnosticsEmbed(snapshot, config, { rss: memory.rss, heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal, gatewayMs: context.gatewayPing(), historySize: history.size,
        reports: reports.status(), now: Date.now() }));
    }
    if (name === 'snapshot') {
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

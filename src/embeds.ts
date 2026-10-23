import { EmbedBuilder } from 'discord.js';
import type { Config } from './config.js';
import type { Snapshot } from './metrics.js';
import { VERSION } from './version.js';

export const BRAND_COLOR = 0x007db8;
export const FOOTER = `Optiplex • v${VERSION} • dvc.labs`;

export function baseEmbed(title: string, date = new Date()): EmbedBuilder {
  return new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: 'Optiplex' })
    .setTitle(title).setFooter({ text: FOOTER }).setTimestamp(date);
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'Unavailable';
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  return `${days ? `${days}d ` : ''}${hours}h ${minutes % 60}m`;
}

function gib(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(2)} GiB`; }

export function aboutEmbed(config: Config): EmbedBuilder {
  return baseEmbed('About Optiplex')
    .setDescription('A small companion for optiplex: keeping an eye on the home lab, one temperature reading at a time.')
    .addFields(
      { name: 'Version', value: `v${VERSION}`, inline: true },
      { name: 'Monitoring', value: config.hostName, inline: true },
      { name: 'Bot uptime', value: formatDuration(process.uptime()), inline: true },
      { name: 'Features', value: 'Startup notifications • CPU temperatures • CPU usage • Memory • Host uptime' },
      { name: 'Scheduled reports', value: `Every ${config.intervalMinutes} minutes in <#${config.channelId}>` },
      { name: 'Source', value: '[dvc-labs/optiplex](https://github.com/dvc-labs/optiplex)' },
    );
}

export function statsEmbed(snapshot: Snapshot, config: Config, startup = false): EmbedBuilder {
  const memory = snapshot.memory;
  const packageSensor = snapshot.temperatures.find((value) => /^Package/i.test(value.label));
  const cores = snapshot.temperatures.filter((value) => /^Core\s/i.test(value.label));
  const hottest = snapshot.temperatures.length ? Math.max(...snapshot.temperatures.map((value) => value.celsius)) : null;
  const embed = baseEmbed(startup ? 'Optiplex monitor is online' : 'Optiplex · Host snapshot', snapshot.capturedAt)
    .setDescription(startup
      ? `Connected to Discord and monitoring **${config.hostName}**. A bot start can also be a deployment or container restart; host uptime is shown separately.`
      : `A fresh look at **${config.hostName}**.`)
    .addFields(
      { name: 'Host uptime', value: formatDuration(snapshot.hostUptime), inline: true },
      { name: 'Bot uptime', value: formatDuration(snapshot.botUptime), inline: true },
      { name: 'CPU busy · 1s sample', value: snapshot.cpuPercent === null ? 'Unavailable' : `${snapshot.cpuPercent.toFixed(1)}%${snapshot.cores ? ` · ${snapshot.cores} logical CPUs` : ''}`, inline: true },
      { name: 'Host memory', value: memory ? `${gib(memory.used)} / ${gib(memory.total)} · ${memory.percent.toFixed(1)}% used\n${gib(memory.available)} available` : 'Unavailable', inline: true },
      { name: 'Load average · 1 / 5 / 15 min', value: snapshot.load?.map((value) => value.toFixed(2)).join(' / ') ?? 'Unavailable', inline: true },
      { name: 'CPU package', value: packageSensor ? `${packageSensor.celsius.toFixed(1)} °C` : 'Unavailable', inline: true },
    );
  if (cores.length) embed.addFields({ name: 'CPU cores', value: cores.map((sensor) => `${sensor.label}: **${sensor.celsius.toFixed(1)} °C**`).join(' · ').slice(0, 1024) });
  if (snapshot.unavailable.length) embed.addFields({ name: 'Unavailable readings', value: snapshot.unavailable.join(', ') });
  if (hottest !== null && hottest >= 80) embed.setColor(0xe6a23c);
  return embed;
}

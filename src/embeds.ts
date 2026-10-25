import { EmbedBuilder } from 'discord.js';
import type { Config } from './config.js';
import type { Snapshot } from './metrics.js';
import { hottestTemperature } from './metrics.js';
import type { ReportStatus } from './controls.js';
import { QUERY_CACHE_MS, type HistorySummary, type MetricSummary } from './history.js';
import type { TelemetryStatus } from './telemetry.js';
import type { CommandAudit } from './telemetry.js';
import type { HistoryComparison } from './history-query.js';
import type { ExternalHeartbeatStatus } from './heartbeat.js';
import { THERMAL_WARN_C, THERMAL_RECOVER_C, type ThermalEvent } from './monitoring.js';
import { VERSION } from './version.js';

export const BRAND_COLOR = 0x007db8;
export const FOOTER = `Optimon • v${VERSION} • dvc.labs`;

export function baseEmbed(title: string, date = new Date()): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: 'Optimon' })
    .setTitle(title)
    .setFooter({ text: FOOTER })
    .setTimestamp(date);
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'Unavailable';
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  return `${days ? `${days}d ` : ''}${hours}h ${minutes % 60}m`;
}

export function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
function timestamp(ms: number, style = 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function aboutEmbed(config: Config, reports?: ReportStatus): EmbedBuilder {
  return baseEmbed('About Optimon')
    .setDescription(
      'A small companion for optiplex: keeping an eye on the home lab, one temperature reading at a time.',
    )
    .addFields(
      { name: 'Version', value: `v${VERSION}`, inline: true },
      { name: 'Monitoring', value: config.hostName, inline: true },
      { name: 'Bot uptime', value: formatDuration(process.uptime()), inline: true },
      {
        name: 'Features',
        value:
          'Live stats • Swap usage • Uptime • Archived trends • Comparisons • Thermal alerts • Server moods\nTry `/help`.',
      },
      {
        name: 'Scheduled reports',
        value: reports?.pausedUntil
          ? `Paused until ${timestamp(reports.pausedUntil, 't')}`
          : `Every ${config.intervalMinutes} minutes in <#${config.channelId}>`,
      },
      { name: 'Source', value: '[dvc-labs/optimon](https://github.com/dvc-labs/optimon)' },
    );
}

export function statsEmbed(snapshot: Snapshot, config: Config, startup = false): EmbedBuilder {
  const memory = snapshot.memory;
  const packageSensor = snapshot.temperatures.find((value) => /^Package/i.test(value.label));
  const cores = snapshot.temperatures.filter((value) => /^Core\s/i.test(value.label));
  const hottest = snapshot.temperatures.length
    ? Math.max(...snapshot.temperatures.map((value) => value.celsius))
    : null;
  const embed = baseEmbed(
    startup ? 'Optimon is online' : 'Optimon · Host snapshot',
    snapshot.capturedAt,
  )
    .setDescription(
      startup
        ? `Connected to Discord and monitoring **${config.hostName}**. ` +
            'A bot start can also be a deployment or container restart; host uptime is shown separately.'
        : `A fresh look at **${config.hostName}**.`,
    )
    .addFields(
      { name: 'Host uptime', value: formatDuration(snapshot.hostUptime), inline: true },
      { name: 'Bot uptime', value: formatDuration(snapshot.botUptime), inline: true },
      {
        name: 'CPU busy · 1s sample',
        value:
          snapshot.cpuPercent === null
            ? 'Unavailable'
            : `${snapshot.cpuPercent.toFixed(1)}%${snapshot.cores ? ` · ${snapshot.cores} logical CPUs` : ''}`,
        inline: true,
      },
      {
        name: 'Host memory',
        value: memory
          ? `${gib(memory.used)} / ${gib(memory.total)} · ${memory.percent.toFixed(1)}% used\n${gib(memory.available)} available`
          : 'Unavailable',
        inline: true,
      },
      {
        name: 'Host swap',
        value: snapshot.swap
          ? snapshot.swap.total === 0
            ? 'Not configured'
            : `${gib(snapshot.swap.used)} / ${gib(snapshot.swap.total)} in use`
          : 'Unavailable',
        inline: true,
      },
      {
        name: 'Load average · 1 / 5 / 15 min',
        value: snapshot.load?.map((value) => value.toFixed(2)).join(' / ') ?? 'Unavailable',
        inline: true,
      },
      {
        name: 'CPU package',
        value: packageSensor ? `${packageSensor.celsius.toFixed(1)} °C` : 'Unavailable',
        inline: true,
      },
    );
  if (cores.length)
    embed.addFields({
      name: 'CPU cores',
      value: cores
        .map((sensor) => `${sensor.label}: **${sensor.celsius.toFixed(1)} °C**`)
        .join(' · ')
        .slice(0, 1024),
    });
  if (snapshot.unavailable.length)
    embed.addFields({ name: 'Unavailable readings', value: snapshot.unavailable.join(', ') });
  if (hottest !== null && hottest >= THERMAL_WARN_C) embed.setColor(0xe6a23c);
  return embed;
}

export function helpEmbed(): EmbedBuilder {
  return baseEmbed('Optimon · Command guide')
    .setDescription('A tiny Dell with opinions and telemetry.')
    .addFields(
      {
        name: 'Live readings',
        value:
          '`/stats` — host CPU, RAM, swap and temperatures.\n`/uptime` — separate host/bot uptime and estimated start times.',
      },
      {
        name: 'Nerd corner',
        value: [
          '`/history` — 1h, 6h, 24h, 7d, 30d or 365d.',
          '`/compare` — compare consecutive windows.',
          '`/ping` — Discord latency.',
          '`/vibe` — a playful take on the readings.',
        ].join('\n'),
      },
      {
        name: 'Owner controls · private replies',
        value: [
          '`/diagnostics` — resources, storage and delivery status.',
          '`/audit` — timestamped command records.',
          '`/snapshot` — post a snapshot.',
          '`/pause` / `/resume` — pause scheduled reports.',
        ].join('\n'),
      },
      {
        name: 'How monitoring works',
        value:
          'One background sample about every minute; interactive readings can be cached for 15 seconds. ' +
          'Metric history stays on disk. History queries use a worker and a 60-second result cache. ' +
          'Thermal alerts continue during a report pause.',
      },
    );
}

export function uptimeEmbed(snapshot: Snapshot, config: Config): EmbedBuilder {
  const now = snapshot.capturedAt.getTime();
  return baseEmbed('Optimon · Uptime', snapshot.capturedAt)
    .setDescription(`The clocks aboard **${config.hostName}**.`)
    .addFields(
      { name: 'Host uptime', value: formatDuration(snapshot.hostUptime), inline: true },
      { name: 'Bot uptime', value: formatDuration(snapshot.botUptime), inline: true },
      {
        name: 'Estimated host boot',
        value:
          snapshot.hostUptime === null
            ? 'Unavailable'
            : `${timestamp(now - snapshot.hostUptime * 1000, 'F')}\n${timestamp(now - snapshot.hostUptime * 1000)}`,
      },
      { name: 'Estimated bot start', value: timestamp(now - snapshot.botUptime * 1000, 'F') },
    );
}

function formatWindow(minutes: number): string {
  return minutes >= 10080 ? `${minutes / 1440}d` : `${minutes / 60}h`;
}
function signedDelta(value: number): string {
  const rounded = Number(value.toFixed(1));
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

export function historyEmbed(history: HistorySummary): EmbedBuilder {
  const embed = baseEmbed(`Optimon · Last ${formatWindow(history.minutes)}`).setDescription(
    history.count
      ? `${history.count} periodic samples in this window.\n` +
          '24 equal time buckets, oldest → newest; `·` means no reading. ' +
          'Graph scale: 0–100% or 0–100 °C (higher temperatures saturate the graph).'
      : 'No samples in this time window yet. The first sample is collected at startup.',
  );
  function field(name: string, summary: MetricSummary | null, unit: string): void {
    embed.addFields({
      name,
      value: summary
        ? `\`${summary.graph}\`\nMin **${summary.min.toFixed(1)}${unit}** · ` +
          `Avg **${summary.mean.toFixed(1)}${unit}** · Peak **${summary.max.toFixed(1)}${unit}**\n` +
          `${summary.count} readings`
        : 'Unavailable',
    });
  }
  field('CPU busy · 1s samples', history.cpu, '%');
  field('Host memory used', history.memory, '%');
  field('Hottest CPU sensor', history.temperature, ' °C');
  if (history.firstAt !== null && history.lastAt !== null)
    embed.addFields({
      name: 'Recorded coverage',
      value:
        `${timestamp(history.firstAt, 'F')} → ${timestamp(history.lastAt, 'F')}\n` +
        'Saved history survives restarts. Offline periods appear as gaps; ' +
        'these are sampled readings, not continuous measurements.',
    });
  return embed;
}

export function pingEmbed(gatewayMs: number, acknowledgementMs: number): EmbedBuilder {
  return baseEmbed('Optimon · Discord connection')
    .setDescription('Timing the trip from this bot to Discord.')
    .addFields(
      {
        name: 'Gateway heartbeat',
        value:
          gatewayMs >= 0 && Number.isFinite(gatewayMs)
            ? `${Math.round(gatewayMs)} ms`
            : 'Waiting for a heartbeat',
        inline: true,
      },
      {
        name: 'API acknowledgement',
        value: `${Math.max(0, Math.round(acknowledgementMs))} ms`,
        inline: true,
      },
      {
        name: 'What these measure',
        value:
          'Gateway WebSocket heartbeat latency and the time taken to acknowledge this command ' +
          'through the Discord API, including SDK queueing.',
      },
    );
}

export function vibeEmbed(snapshot: Snapshot): EmbedBuilder {
  const temperature = hottestTemperature(snapshot);
  let mood: string;
  if (temperature !== null && temperature >= THERMAL_WARN_C)
    mood = 'Toasty. I am an OptiPlex, not an air fryer. Some airflow would be lovely.';
  else if (snapshot.memory && snapshot.memory.percent >= 85)
    mood = 'Someone has been collecting containers again. The RAM would like a word.';
  else if (snapshot.cpuPercent !== null && snapshot.cpuPercent >= 70)
    mood = 'Finally, some work. These cores were beginning to feel decorative.';
  else if (snapshot.cpuPercent === null && temperature === null && !snapshot.memory)
    mood = 'Discord works, but my sensors are giving me the silent treatment.';
  else if ((snapshot.hostUptime ?? 0) >= 7 * 86400)
    mood = 'A week on duty. I am now part of the furniture, with slightly better uptime.';
  else
    mood =
      `${snapshot.cores ? `${snapshot.cores} logical CPUs` : 'A tiny chassis'} and an Ethernet cable. ` +
      'I am dramatically overqualified for watching my own temperature.';
  return baseEmbed('Optimon · Current mood', snapshot.capturedAt)
    .setDescription(mood)
    .addFields(
      {
        name: 'The actual readings',
        value: [
          `CPU: ${snapshot.cpuPercent?.toFixed(1) ?? 'Unavailable'}${snapshot.cpuPercent === null ? '' : '%'}`,
          `Memory: ${snapshot.memory ? `${snapshot.memory.percent.toFixed(1)}% used` : 'Unavailable'}`,
          `Hottest CPU sensor: ${temperature === null ? 'Unavailable' : `${temperature.toFixed(1)} °C`}`,
        ].join('\n'),
      },
      {
        name: 'A little personality',
        value: 'Snapshot-based humour; use the stats and trends for the measurements.',
      },
    );
}

export interface Diagnostics {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  gatewayMs: number;
  reports: ReportStatus;
  now: number;
  historyStorage: TelemetryStatus;
  heartbeat?: ExternalHeartbeatStatus;
}
export function diagnosticsEmbed(
  snapshot: Snapshot,
  config: Config,
  data: Diagnostics,
): EmbedBuilder {
  return baseEmbed('Optimon · Owner diagnostics')
    .setDescription(
      'Bot process resources, persisted history and telemetry status. Process counters reset when the bot restarts.',
    )
    .addFields(
      { name: 'Bot RAM · RSS', value: `${(data.rss / 1024 ** 2).toFixed(1)} MiB`, inline: true },
      {
        name: 'JavaScript heap',
        value: `${(data.heapUsed / 1024 ** 2).toFixed(1)} / ${(data.heapTotal / 1024 ** 2).toFixed(1)} MiB used / allocated`,
        inline: true,
      },
      { name: 'Bot uptime', value: formatDuration(process.uptime()), inline: true },
      {
        name: 'History queries',
        value: `Read-only worker · cache up to ${QUERY_CACHE_MS / 1000}s`,
        inline: true,
      },
      {
        name: 'History storage',
        value: [
          data.historyStorage.healthy
            ? 'Healthy · persistent database'
            : 'Degraded · check storage logs',
          `Last metric save: ${data.historyStorage.lastSavedAt === null ? 'None yet' : timestamp(data.historyStorage.lastSavedAt)}`,
        ].join('\n'),
      },
      {
        name: 'Metrics · no automatic expiry',
        value: [
          `${data.historyStorage.metricCount} metric samples`,
          `Oldest sample: ${data.historyStorage.firstAt ? timestamp(data.historyStorage.firstAt, 'F') : 'None yet'}`,
          `Pending samples: ${data.historyStorage.pendingSamples} · ` +
            `Unsaved samples dropped: ${data.historyStorage.droppedSamples}`,
          `Corruption recoveries: ${data.historyStorage.recoveries}`,
        ].join('\n'),
      },
      {
        name: 'Snapshot age',
        value: `${Math.max(0, Math.round((data.now - snapshot.capturedAt.getTime()) / 1000))} seconds`,
        inline: true,
      },
      {
        name: 'Gateway heartbeat',
        value:
          data.gatewayMs >= 0 && Number.isFinite(data.gatewayMs)
            ? `${Math.round(data.gatewayMs)} ms`
            : 'Waiting',
        inline: true,
      },
      {
        name: 'Scheduled reports',
        value: data.reports.pausedUntil
          ? `Paused until ${timestamp(data.reports.pausedUntil, 'F')}`
          : `Every ${config.intervalMinutes} minutes`,
      },
      {
        name: 'Last successful snapshot post',
        value:
          data.reports.lastReportAt === null ? 'None yet' : timestamp(data.reports.lastReportAt),
      },
      {
        name: 'Command audit retention',
        value: `${data.historyStorage.commandCount} records · ${config.auditRetentionDays === 0 ? 'no automatic expiry' : `${config.auditRetentionDays} days`}`,
      },
      { name: 'Report delivery failures', value: String(data.reports.failures), inline: true },
      {
        name: 'Thermal delivery failures',
        value: String(data.reports.thermalFailures ?? 0),
        inline: true,
      },
      {
        name: 'Command audit failures',
        value: String(data.historyStorage.auditFailures),
        inline: true,
      },
      {
        name: 'Thermal alerts',
        value: config.thermalAlerts
          ? `Enabled · ${THERMAL_WARN_C} °C warning / ${THERMAL_RECOVER_C} °C recovery`
          : 'Disabled',
        inline: true,
      },
      {
        name: 'External heartbeat',
        value: data.heartbeat?.enabled
          ? `Last success: ${data.heartbeat.lastSuccessAt === null ? 'None yet' : timestamp(data.heartbeat.lastSuccessAt)} · ` +
            `Failures: ${data.heartbeat.failures}`
          : 'Disabled',
      },
      { name: 'Unavailable readings', value: snapshot.unavailable.join(', ') || 'None' },
    );
}

export function comparisonEmbed(comparison: HistoryComparison): EmbedBuilder {
  const { current, previous } = comparison;
  const embed = baseEmbed(
    `Optimon · Compare ${formatWindow(current.minutes)} windows`,
  ).setDescription(
    'Current window versus the immediately preceding window. Values are averages of periodic samples; gaps can affect comparisons.',
  );
  for (const [label, key, unit] of [
    ['CPU busy', 'cpu', '%'],
    ['Host memory', 'memory', '%'],
    ['Hottest CPU sensor', 'temperature', ' °C'],
  ] as const) {
    const a = current[key];
    const b = previous[key];
    embed.addFields({
      name: label,
      value:
        a && b
          ? `${b.mean.toFixed(1)}${unit} → ${a.mean.toFixed(1)}${unit} · ` +
            `Δ ${signedDelta(a.mean - b.mean)}${key === 'temperature' ? ' °C' : ' percentage points'}`
          : 'Both windows need readings before a comparison is available.',
    });
  }
  for (const [label, summary] of [
    ['Current coverage', current],
    ['Previous coverage', previous],
  ] as const) {
    embed.addFields({
      name: label,
      value:
        summary.firstAt !== null && summary.lastAt !== null
          ? `${summary.count} samples\n${timestamp(summary.firstAt, 'F')} → ${timestamp(summary.lastAt, 'F')}`
          : 'No recorded samples',
    });
  }
  return embed;
}

export function auditEmbed(entries: readonly CommandAudit[]): EmbedBuilder {
  const embed = baseEmbed('Optimon · Command audit').setDescription(
    'Private execution metadata. Arguments, message contents and credentials are not recorded.',
  );
  if (!entries.length)
    return embed.addFields({ name: 'Records', value: 'No command records yet.' });
  for (const entry of entries)
    embed.addFields({
      name: `/${entry.command} · ${entry.outcome}`,
      value: [
        `User: ${entry.actorId}`,
        `Started: ${timestamp(entry.startedAt, 'F')}`,
        entry.finishedAt === null
          ? 'No completion recorded'
          : `Finished: ${timestamp(entry.finishedAt, 'F')} · ${entry.durationMs ?? 0} ms`,
      ].join('\n'),
    });
  return embed;
}

export function thermalEmbed(event: ThermalEvent, snapshot: Snapshot): EmbedBuilder {
  const temperature = hottestTemperature(snapshot);
  return baseEmbed(
    event === 'hot'
      ? 'Optimon · Sustained CPU temperature warning'
      : 'Optimon · CPU temperature recovered',
    snapshot.capturedAt,
  )
    .setColor(event === 'hot' ? 0xe6a23c : 0x2eaf7d)
    .setDescription(
      event === 'hot'
        ? `The hottest CPU sensor reached at least **${THERMAL_WARN_C} °C** in two consecutive background samples.`
        : `The hottest CPU sensor stayed at or below **${THERMAL_RECOVER_C} °C** in two consecutive background samples.`,
    )
    .addFields(
      {
        name: 'Hottest CPU sensor',
        value: temperature === null ? 'Unavailable' : `${temperature.toFixed(1)} °C`,
        inline: true,
      },
      { name: 'Host uptime', value: formatDuration(snapshot.hostUptime), inline: true },
      {
        name: 'Sampling',
        value:
          'About one sample per minute. One notice per confirmed transition; no automatic mentions.',
      },
    );
}

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
import type { ExportStatus } from './dashboard-publisher.js';
import type { ConnectionStatus } from './discord-connection.js';
import {
  GAP_THRESHOLD_MS,
  type StartupContext,
  type AvailabilityWindow,
  type MonitoringAvailability,
} from './availability.js';
import {
  THERMAL_WARN_C,
  THERMAL_RECOVER_C,
  DISK_WARN_PERCENT,
  DISK_RECOVER_PERCENT,
  type ThermalEvent,
} from './monitoring.js';
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
function percentage(value: number | null): string {
  return value === null ? 'Unavailable' : `${value.toFixed(1)}%`;
}

export function aboutEmbed(config: Config, reports?: ReportStatus): EmbedBuilder {
  const embed = baseEmbed('About Optimon')
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
          'Live stats • Swap usage • Uptime • Monitoring gaps • Archived trends • Comparisons • Alerts • Server moods\nTry `/help`.',
      },
      {
        name: 'Scheduled reports',
        value: reports?.pausedUntil
          ? `Paused until ${timestamp(reports.pausedUntil, 't')}`
          : `Every ${config.intervalMinutes} minutes in <#${config.channelId}>`,
      },
      { name: 'Source', value: '[dvc-labs/optimon](https://github.com/dvc-labs/optimon)' },
    );
  if (config.dashboardUrl)
    embed.addFields({
      name: 'Dashboard',
      value: `[Live readings and history](${config.dashboardUrl}/)`,
    });
  return embed;
}

export function statsEmbed(
  snapshot: Snapshot,
  config: Config,
  startup = false,
  context: StartupContext | null = null,
): EmbedBuilder {
  const memory = snapshot.memory;
  const packageSensor = snapshot.temperatures.find((value) => /^Package/i.test(value.label));
  const cores = snapshot.temperatures.filter((value) => /^Core\s/i.test(value.label));
  const hottest = snapshot.temperatures.length
    ? Math.max(...snapshot.temperatures.map((value) => value.celsius))
    : null;
  const embed = baseEmbed(
    startup
      ? context?.previousAt !== null && context?.previousAt !== undefined
        ? context.firstAt - context.previousAt > GAP_THRESHOLD_MS
          ? 'Optimon · Monitoring resumed'
          : 'Optimon · Monitor restarted'
        : 'Optimon is online'
      : 'Optimon · Host snapshot',
    snapshot.capturedAt,
  )
    .setDescription(
      startup
        ? `Connected to Discord and monitoring **${config.hostName}**. ` +
            startupDescription(context)
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
  const details = snapshot.cpuDetails;
  if (details)
    embed.addFields({
      name: 'CPU detail · 1s sample',
      value:
        `I/O wait: ${percentage(details.iowaitPercent)} · Steal: ${percentage(details.stealPercent)}\n` +
        details.perCore
          .map((core) => `Core ${core.id}: ${percentage(core.percent)}`)
          .join(' · ')
          .slice(0, 800),
    });
  if (snapshot.runnableTasks !== null && snapshot.runnableTasks !== undefined)
    embed.addFields({
      name: 'Runnable tasks',
      value: String(snapshot.runnableTasks),
      inline: true,
    });
  if (snapshot.disk)
    embed.addFields({
      name: 'Root filesystem space',
      value: `${gib(snapshot.disk.used)} used · ${gib(snapshot.disk.available)} available · ${snapshot.disk.percent.toFixed(1)}% of usable space`,
      inline: true,
    });
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

function startupDescription(context: StartupContext | null): string {
  if (!context || context.previousAt === null)
    return 'This is the first recorded start in this archive. Host uptime is shown separately.';
  const gap = context.firstAt - context.previousAt;
  const booted =
    context.bootTime !== null &&
    context.bootTime > context.previousAt &&
    context.bootTime <= context.firstAt + 5000;
  const bootKnown = context.bootTime !== null && context.bootTime <= context.firstAt + 5000;
  const cause = booted
    ? 'The host boot time suggests a reboot since the previous reading.'
    : bootKnown
      ? 'The current host boot predates the previous reading; the monitor restarted on an already-running host.'
      : 'The host boot time was not available, so the cause is unknown.';
  return `${gap > GAP_THRESHOLD_MS ? `Monitoring resumed about **${formatDuration(gap / 1000)}** after the last archived reading. ` : 'The monitor restarted. '}${cause} A gap alone does not prove the host was powered off.`;
}

export function helpEmbed(config?: Config): EmbedBuilder {
  const embed = baseEmbed('Optimon · Command guide')
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
          '`/outages` — 7/30-day monitoring coverage and recent gaps.',
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
          'Thermal and disk alerts continue during a report pause. Sampling continues while Discord is disconnected.',
      },
    );
  if (config?.dashboardUrl)
    embed.addFields({
      name: 'Dashboard',
      value: `[Live readings and history](${config.dashboardUrl}/)`,
    });
  return embed;
}

export function uptimeEmbed(
  snapshot: Snapshot,
  config: Config,
  availability?: MonitoringAvailability,
): EmbedBuilder {
  const now = snapshot.capturedAt.getTime();
  const boot =
    snapshot.bootTime ?? (snapshot.hostUptime === null ? null : now - snapshot.hostUptime * 1000);
  const embed = baseEmbed('Optimon · Uptime', snapshot.capturedAt)
    .setDescription(`The clocks aboard **${config.hostName}**.`)
    .addFields(
      { name: 'Host uptime', value: formatDuration(snapshot.hostUptime), inline: true },
      { name: 'Bot uptime', value: formatDuration(snapshot.botUptime), inline: true },
      {
        name: snapshot.bootTime ? 'Host boot · /proc/stat' : 'Estimated host boot',
        value: boot === null ? 'Unavailable' : `${timestamp(boot, 'F')}\n${timestamp(boot)}`,
      },
      { name: 'Estimated bot start', value: timestamp(now - snapshot.botUptime * 1000, 'F') },
    );
  for (const window of availability?.windows ?? [])
    embed.addFields({
      name: `${window.days}-day monitoring availability`,
      value: coverageDescription(window),
    });
  return embed;
}

function coverageDescription(window: AvailabilityWindow): string {
  if (window.observedFrom === null) return 'No archived readings yet.';
  if (window.coveragePercent === null)
    return 'First reading archived; waiting for elapsed monitoring time.';
  return (
    `**${window.coveragePercent.toFixed(1)}%** estimated monitoring coverage over ${formatDuration(window.observedMs / 1000)}; about ${formatDuration(window.missingMs / 1000)} missing after a 90-second allowance per sample.\n` +
    `Observed since ${timestamp(window.observedFrom, 'F')}. ${window.gapCount} monitoring gaps over 3.5 minutes. This is sample coverage, not proven host uptime.`
  );
}
export function outagesEmbed(window: AvailabilityWindow): EmbedBuilder {
  const embed = baseEmbed(`Optimon · Monitoring gaps · ${window.days} days`)
    .setDescription(
      'Derived from archived timestamps. Missing samples can mean a monitor restart, storage failure, reboot or power-off. Boundaries are approximate to about one sample; no cause is inferred for historical gaps.',
    )
    .addFields({ name: 'Monitoring availability', value: coverageDescription(window) });
  if (!window.recentGaps.length)
    return embed.addFields({
      name: 'Recent gaps',
      value:
        window.observedFrom === null
          ? 'No recorded history yet.'
          : 'No gaps over 3.5 minutes in the observed period.',
    });
  for (const gap of window.recentGaps)
    embed.addFields({
      name: gap.resumedAt === null ? 'No newer archived sample' : 'Monitoring resumed',
      value: `Last sample: ${timestamp(gap.lastSeenAt, 'F')}\n${gap.resumedAt === null ? 'Still missing as of this query.' : `Next sample: ${timestamp(gap.resumedAt, 'F')}`}\nAbout ${formatDuration(gap.durationMs / 1000)} missing within this window, after the 90-second sample allowance.`,
    });
  return embed;
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
  dashboard?: ExportStatus | null;
  connection?: ConnectionStatus | null;
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
      {
        name: 'Dashboard exports',
        value: data.dashboard
          ? [
              `Live: ${data.dashboard.liveHealthy === null ? 'Waiting' : data.dashboard.liveHealthy ? 'Healthy' : 'Failed'} · failures ${data.dashboard.liveFailures}`,
              `Last live success: ${data.dashboard.lastLiveAt === null ? 'None yet' : timestamp(data.dashboard.lastLiveAt)}`,
              `History: ${data.dashboard.historyHealthy === null ? 'Waiting' : data.dashboard.historyHealthy ? 'Healthy' : 'Failed'} · failures ${data.dashboard.historyFailures}`,
              `Last history success: ${data.dashboard.lastHistoryAt === null ? 'None yet' : timestamp(data.dashboard.lastHistoryAt)}`,
            ].join('\n')
          : 'Disabled',
      },
      {
        name: 'Discord session',
        value: data.connection
          ? [
              data.connection.connected ? 'Connected' : 'Disconnected',
              `Login failures: ${data.connection.loginFailures} · setup failures: ${data.connection.registrationFailures} · reconnects: ${data.connection.reconnects}`,
              `Last ready: ${data.connection.lastReadyAt === null ? 'None yet' : timestamp(data.connection.lastReadyAt)}`,
              `Last disconnect: ${data.connection.lastDisconnectAt === null ? 'None yet' : timestamp(data.connection.lastDisconnectAt)}`,
              `Last resume: ${data.connection.lastResumeAt === null ? 'None yet' : timestamp(data.connection.lastResumeAt)}`,
            ].join('\n')
          : 'Session diagnostics unavailable',
      },
      {
        name: 'Disk alerts',
        value: `${config.diskAlerts ? 'Enabled when mounted' : 'Disabled'} · ${DISK_WARN_PERCENT}% warning / ${DISK_RECOVER_PERCENT}% recovery · delivery failures ${data.reports.diskFailures ?? 0}`,
      },
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

export function diskEmbed(event: ThermalEvent, snapshot: Snapshot): EmbedBuilder {
  return baseEmbed(
    event === 'hot' ? 'Optimon · Sustained disk space warning' : 'Optimon · Disk space recovered',
    snapshot.capturedAt,
  )
    .setColor(event === 'hot' ? 0xe6a23c : 0x2eaf7d)
    .setDescription(
      event === 'hot'
        ? `Root filesystem usage reached at least **${DISK_WARN_PERCENT}%** in two consecutive background samples.`
        : `Root filesystem usage stayed at or below **${DISK_RECOVER_PERCENT}%** in two consecutive background samples.`,
    )
    .addFields(
      {
        name: 'Space',
        value: snapshot.disk
          ? `${gib(snapshot.disk.used)} used · ${gib(snapshot.disk.available)} available · ${snapshot.disk.percent.toFixed(1)}% of usable space`
          : 'Unavailable',
      },
      {
        name: 'Scope',
        value:
          'Read-only filesystem capacity from the dedicated empty host mount. No files are read or deleted.',
      },
    );
}

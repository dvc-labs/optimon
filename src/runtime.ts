import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from './config.js';
import type { SnapshotPublisher } from './dashboard-publisher.js';
import { handleCommand, isKnownCommand, type CommandContext } from './commands.js';
import { Cooldown, ReportControls } from './controls.js';
import { baseEmbed, statsEmbed, thermalEmbed } from './embeds.js';
import { ExternalHeartbeat } from './heartbeat.js';
import { pointFromSnapshot } from './history.js';
import type { HistoryReader } from './history-query.js';
import { log, safeError } from './log.js';
import { hottestTemperature, type Snapshot } from './metrics.js';
import { MetricsCache, SAMPLE_INTERVAL_MS, ThermalWatch } from './monitoring.js';
import type { BotReporter } from './reporter.js';
import { scheduleReports } from './scheduler.js';
import type { CommandOutcome, TelemetryStore } from './telemetry.js';
import { VERSION } from './version.js';

export interface RuntimeGateway {
  applicationId(): string;
  isReady(): boolean;
  ping(): number;
  register(): Promise<void>;
  activity(text: string): void;
  destroy(): Promise<void>;
}
interface RuntimeOptions {
  gateway: RuntimeGateway;
  telemetry: TelemetryStore;
  archive: HistoryReader;
  reporter: Pick<BotReporter, 'send'>;
  collect: () => Promise<Snapshot>;
  heartbeat?: ExternalHeartbeat;
  publisher?: SnapshotPublisher;
  schedule?: typeof scheduleReports;
  logger?: typeof log;
  now?: () => number;
}

export class MonitorRuntime {
  readonly reports = new ReportControls();
  readonly thermal = new ThermalWatch();
  readonly cache: MetricsCache;
  private readonly context: CommandContext;
  private readonly heartbeat: ExternalHeartbeat;
  private readonly schedule: typeof scheduleReports;
  private readonly logger: typeof log;
  private tasks = new Set<Promise<unknown>>();
  private stopping = false;
  private initialized = false;
  private startup: Promise<void> | null = null;
  private shutdown: Promise<void> | null = null;
  private nextAuditCleanup = 0;
  private readonly now: () => number;
  private stopSamples: (() => void) | null = null;
  private stopReports: (() => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly options: RuntimeOptions,
  ) {
    this.logger = options.logger ?? log;
    this.schedule = options.schedule ?? scheduleReports;
    this.heartbeat = options.heartbeat ?? new ExternalHeartbeat(config.heartbeatUrl);
    const now = options.now ?? Date.now;
    this.now = now;
    this.cache = new MetricsCache(async () => {
      const snapshot = await options.collect();
      if (snapshot.unavailable.length)
        this.logger('metrics_unavailable', { readings: snapshot.unavailable });
      return snapshot;
    }, now);
    this.context = {
      config,
      cache: this.cache,
      reports: this.reports,
      reporter: options.reporter,
      cooldown: new Cooldown(10_000),
      manualCooldown: new Cooldown(60_000, 1),
      gatewayPing: () => options.gateway.ping(),
      historyStorage: options.telemetry,
      archive: {
        summary: (minutes) => options.archive.summary(minutes),
        compare: (minutes) => options.archive.compare(minutes),
        recentCommands: (limit) => options.telemetry.recentCommands(limit),
      },
      heartbeatStatus: () => this.heartbeat.status(),
    };
  }

  get ready(): boolean {
    return this.initialized && !this.stopping && this.options.gateway.isReady();
  }

  private track<T>(task: Promise<T>): Promise<T> {
    const tracked = task.finally(() => {
      this.tasks.delete(tracked);
    });
    this.tasks.add(tracked);
    return tracked;
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.startup ??= this.track(this.startInternal());
    return this.startup;
  }

  private async startInternal(): Promise<void> {
    if (this.options.gateway.applicationId() !== this.config.applicationId) {
      throw Object.assign(new Error('Application ID mismatch.'), { name: 'ApplicationIdMismatch' });
    }
    await this.options.gateway.register();
    if (this.stopping) return;
    this.initialized = true;
    this.logger('ready', {
      version: VERSION,
      host: this.config.hostName,
      reportIntervalMinutes: this.config.intervalMinutes,
      ownerControlsEnabled: this.config.adminId !== null,
      thermalAlertsEnabled: this.config.thermalAlerts,
      heartbeatEnabled: this.config.heartbeatUrl !== null,
    });
    await this.sample();
    if (this.stopping) return;
    this.stopSamples = this.schedule(
      () => this.sample(),
      SAMPLE_INTERVAL_MS,
      (error) => this.logger('monitor_sample_failed', safeError(error)),
    );
    this.stopReports = this.schedule(
      () => this.postScheduled(),
      this.config.intervalMinutes * 60_000,
      (error) => this.logger('scheduled_report_task_failed', safeError(error)),
    );
    try {
      const embed = statsEmbed(await this.cache.getSnapshot(), this.config, true);
      if (this.stopping) return;
      const storage = this.options.telemetry.status();
      if (storage.recoveries)
        embed.addFields({
          name: 'Storage recovery',
          value:
            'Corrupt data was preserved separately and monitoring resumed. The owner can check diagnostics and backups.',
        });
      await this.options.reporter.send(embed);
      this.reports.lastReportAt = Date.now();
    } catch (error) {
      this.reports.failures++;
      this.logger('startup_notification_failed', safeError(error));
    }
  }

  sample(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(this.sampleInternal());
  }

  private async sampleInternal(): Promise<void> {
    const snapshot = await this.cache.getSnapshot();
    if (this.stopping) return;
    const point = pointFromSnapshot(snapshot);
    try {
      this.options.telemetry.recordMetrics(point ? [point] : []);
    } catch (error) {
      this.logger('metric_archive_write_failed', safeError(error));
    }
    // Start the public export now so the page stays fresh, but never make thermal alerts or the
    // external heartbeat wait for a slow archive query. It is awaited (and cannot reject) below.
    const exported = this.exportPublic(snapshot);
    if (this.now() >= this.nextAuditCleanup) {
      try {
        const removed = this.options.telemetry.pruneCommands(
          this.config.auditRetentionDays,
          this.now(),
        );
        if (removed) this.logger('audit_records_expired', { records: removed });
        this.nextAuditCleanup = this.now() + 3600_000;
      } catch (error) {
        this.nextAuditCleanup = this.now() + 15 * 60_000;
        this.logger('audit_retention_failed', safeError(error));
      }
    }
    if (this.options.gateway.isReady()) {
      const temperature = hottestTemperature(snapshot);
      const readings = [
        temperature === null ? null : `${temperature.toFixed(0)} °C`,
        snapshot.cpuPercent === null ? null : `CPU ${snapshot.cpuPercent.toFixed(0)}%`,
        snapshot.memory === null ? null : `RAM ${snapshot.memory.percent.toFixed(0)}%`,
      ].filter(Boolean);
      this.options.gateway.activity(
        `${this.config.hostName} · ${readings.join(' · ') || 'readings unavailable'}`.slice(0, 128),
      );
    }
    if (this.config.thermalAlerts) {
      const event = this.thermal.observe(snapshot);
      if (event && this.options.gateway.isReady()) {
        try {
          await this.options.reporter.send(thermalEmbed(event, snapshot));
          this.thermal.confirm(event);
          this.logger('thermal_notification_sent', { state: event });
        } catch (error) {
          this.reports.failures++;
          this.reports.thermalFailures++;
          this.logger('thermal_notification_failed', { state: event, ...safeError(error) });
        }
      }
    }
    if (
      this.ready &&
      (snapshot.cpuPercent !== null || snapshot.memory !== null || snapshot.temperatures.length > 0)
    ) {
      try {
        await this.heartbeat.ping();
      } catch (error) {
        this.logger('external_heartbeat_failed', safeError(error));
      }
    }
    await exported;
  }

  private async exportPublic(snapshot: Snapshot): Promise<void> {
    if (!this.options.publisher) return;
    try {
      await this.options.publisher.publish(snapshot);
    } catch (error) {
      this.logger('dashboard_export_failed', safeError(error));
    }
  }

  postScheduled(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(this.postInternal());
  }

  private async postInternal(): Promise<void> {
    if (this.reports.isPaused()) return;
    try {
      const snapshot = await this.cache.getSnapshot();
      if (this.stopping || this.reports.isPaused()) return;
      await this.options.reporter.send(statsEmbed(snapshot, this.config));
      this.reports.lastReportAt = Date.now();
      this.logger('stats_report_sent');
    } catch (error) {
      this.reports.failures++;
      this.logger('stats_report_failed', safeError(error));
    }
  }

  dispatch(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (this.stopping || !isKnownCommand(interaction.commandName)) return Promise.resolve(false);
    return this.track(this.dispatchInternal(interaction));
  }

  private async dispatchInternal(interaction: ChatInputCommandInteraction): Promise<boolean> {
    const started = performance.now();
    let outcome: CommandOutcome = 'ok';
    // Begin Discord acknowledgement before synchronous durable audit work.
    const handling = handleCommand(interaction, {
      ...this.context,
      auditOutcome: (value) => {
        outcome = value;
      },
    });
    const auditable = interaction.guildId === this.config.guildId;
    if (auditable) {
      try {
        this.options.telemetry.startCommand({
          id: interaction.id,
          command: interaction.commandName,
          actorId: interaction.user.id,
          guildId: this.config.guildId,
          channelId: interaction.channelId,
          startedAt: interaction.createdTimestamp,
        });
      } catch (error) {
        this.logger('command_audit_failed', { phase: 'start', ...safeError(error) });
      }
    }
    try {
      await handling;
    } catch (error) {
      outcome = 'failed';
      this.logger('interaction_failed', safeError(error));
      const payload = {
        embeds: [
          baseEmbed('Optimon · Command failed').setDescription(
            'Please try again later. The owner can check the bot logs.',
          ),
        ],
        allowedMentions: { parse: [] as [] },
      };
      try {
        if (interaction.deferred) await interaction.editReply(payload);
        else if (!interaction.replied)
          await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        this.logger('interaction_response_failed', safeError(replyError));
      }
    } finally {
      if (auditable) {
        try {
          this.options.telemetry.finishCommand(
            interaction.id,
            outcome,
            Date.now(),
            performance.now() - started,
          );
        } catch (error) {
          this.logger('command_audit_failed', { phase: 'finish', ...safeError(error) });
        }
      }
    }
    return true;
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    this.initialized = false;
    this.stopSamples?.();
    this.stopReports?.();
    this.heartbeat.stop();
    this.shutdown = (async () => {
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      try {
        await this.options.archive.close();
      } catch (error) {
        this.logger('history_reader_close_failed', safeError(error));
      }
      try {
        this.options.telemetry.flush();
      } catch (error) {
        this.logger('telemetry_shutdown_flush_failed', safeError(error));
      }
      try {
        this.options.telemetry.close();
      } catch (error) {
        this.logger('telemetry_close_failed', safeError(error));
      }
      await this.options.gateway.destroy();
    })();
    return this.shutdown;
  }
}

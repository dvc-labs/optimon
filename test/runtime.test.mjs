import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { ExternalHeartbeat } from '../dist/heartbeat.js';
import { MonitorRuntime } from '../dist/runtime.js';
import { TelemetryStore } from '../dist/telemetry.js';
import { querySummary, queryComparison } from '../dist/history-query.js';
import { config, ownerId, snapshot } from './fixtures.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  let now = Date.now();
  let temperature = 31;
  const events = [];
  const sent = [];
  const jobs = [];
  const logs = [];
  const telemetry = await TelemetryStore.open(':memory:');
  const configuration = config(overrides.config);
  const gateway = {
    applicationId: () => configuration.applicationId,
    isReady: () => true,
    ping: () => 42,
    register: async () => {
      events.push('register');
    },
    activity: (text) => {
      events.push('activity');
      assert.ok(text.length <= 128);
    },
    destroy: async () => {
      events.push('destroy');
    },
  };
  const reporter = {
    send: async (embed) => {
      events.push('send');
      sent.push(embed.toJSON());
    },
  };
  const collect = async () => {
    events.push('collect');
    return snapshot({
      capturedAt: new Date(now),
      temperatures: [{ label: 'Package id 0', celsius: temperature }],
    });
  };
  const archive = {
    summary: async (minutes) => querySummary(telemetry.db, minutes, now),
    compare: async (minutes) => queryComparison(telemetry.db, minutes, now),
    close: async () => {},
  };
  const runtime = new MonitorRuntime(configuration, {
    telemetry,
    archive,
    gateway,
    reporter,
    collect,
    now: () => now,
    schedule: (task, interval, onError) => {
      const job = { task, interval, onError, stopped: false };
      jobs.push(job);
      return () => {
        job.stopped = true;
        events.push('stop-timer');
      };
    },
    logger: (event, details = {}) => {
      logs.push({ event, ...details });
    },
    ...overrides.options,
  });
  t.after(() => runtime.stop());
  let sequence = 0n;
  function interaction(commandName = 'stats', options = {}) {
    const calls = [];
    return {
      id: String(1562643787510063220n + sequence++),
      createdTimestamp: now,
      commandName,
      user: { id: ownerId },
      guildId: configuration.guildId,
      channelId: configuration.channelId,
      deferred: false,
      replied: false,
      options: { getInteger: (key) => options[key] ?? null },
      calls,
      async reply(payload) {
        this.replied = true;
        calls.push(['reply', payload]);
      },
      async deferReply(payload) {
        this.deferred = true;
        calls.push(['defer', payload]);
      },
      async editReply(payload) {
        calls.push(['edit', payload]);
      },
    };
  }
  return {
    runtime,
    archive,
    telemetry,
    gateway,
    reporter,
    events,
    sent,
    jobs,
    logs,
    interaction,
    advance: () => {
      now += 60_000;
    },
    temperature: (value) => {
      temperature = value;
    },
    now: () => now,
  };
}

test('post-ready wiring registers, samples, persists, updates presence and posts once before scheduling', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.runtime.start(), f.runtime.start()]);
  assert.equal(f.runtime.ready, true);
  assert.deepEqual(f.events, ['register', 'collect', 'activity', 'send']);
  assert.equal(f.telemetry.status().metricCount, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].title, 'Optimon is online');
  assert.deepEqual(
    f.jobs.map((job) => job.interval),
    [60_000, 30 * 60_000],
  );
  f.advance();
  await f.jobs[0].task();
  assert.equal(f.telemetry.status().metricCount, 2);
  await f.jobs[1].task();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].title, 'Optimon · Host snapshot');
});

test('thermal send failures have dedicated logs and diagnostic counters and retry before confirmation', async (t) => {
  const f = await fixture(t);
  f.temperature(82);
  await f.runtime.start();
  let rejectThermal = true;
  const send = f.reporter.send;
  f.reporter.send = async (embed) => {
    if (embed.toJSON().title.includes('temperature') && rejectThermal) {
      throw Object.assign(new Error('fixture-private-token-or-endpoint'), {
        name: 'DiscordAPIError',
        status: 403,
      });
    }
    await send(embed);
  };
  f.advance();
  await f.jobs[0].task();
  assert.equal(f.runtime.thermal.active, false);
  assert.equal(f.runtime.reports.failures, 1);
  assert.equal(f.runtime.reports.thermalFailures, 1);
  assert.equal(f.logs.filter((entry) => entry.event === 'thermal_notification_failed').length, 1);
  assert.equal(
    f.logs.some((entry) => entry.event === 'monitor_sample_failed'),
    false,
  );
  assert.ok(!JSON.stringify(f.logs).includes('fixture-private-token-or-endpoint'));
  rejectThermal = false;
  f.advance();
  await f.jobs[0].task();
  assert.equal(f.runtime.thermal.active, true);
  f.temperature(70);
  f.advance();
  await f.jobs[0].task();
  rejectThermal = true;
  f.advance();
  await f.jobs[0].task();
  assert.equal(
    f.runtime.thermal.active,
    true,
    'failed recovery delivery must stay unconfirmed too',
  );
  rejectThermal = false;
  f.advance();
  await f.jobs[0].task();
  assert.equal(f.runtime.thermal.active, false);
  assert.equal(f.runtime.reports.thermalFailures, 2);
  const diagnostics = f.interaction('diagnostics');
  await f.runtime.dispatch(diagnostics);
  const fields = diagnostics.calls[1][1].embeds[0].toJSON().fields;
  assert.equal(fields.find((field) => field.name === 'Thermal delivery failures').value, '2');
  await f.jobs[1].task();
  assert.equal(f.sent.at(-1).title, 'Optimon · Host snapshot');
});

test('pausing channel reports does not pause durable samples, thermal alerts or the external heartbeat', async (t) => {
  let pings = 0;
  const heartbeat = new ExternalHeartbeat('https://example.invalid/fixture', async () => {
    pings++;
    return new Response(null, { status: 200 });
  });
  const f = await fixture(t, {
    config: { HEARTBEAT_URL: 'https://example.invalid/fixture' },
    options: { heartbeat },
  });
  f.temperature(82);
  await f.runtime.start();
  f.runtime.reports.pause(60);
  f.advance();
  await f.jobs[0].task();
  await f.jobs[1].task();
  assert.equal(pings, 2);
  assert.equal(f.telemetry.status().metricCount, 2);
  assert.equal(f.runtime.thermal.active, true);
  assert.equal(f.sent.length, 2, 'only startup and the hot warning should have posted');
});

test('external failures are redacted and unavailable readings or disconnected Discord do not claim health', async (t) => {
  const endpoint = 'https://example.invalid/private-heartbeat-token';
  let calls = 0;
  const heartbeat = new ExternalHeartbeat(endpoint, async () => {
    calls++;
    throw new TypeError(`failed to fetch ${endpoint}`);
  });
  let available = true;
  const f = await fixture(t, {
    config: { HEARTBEAT_URL: endpoint },
    options: {
      heartbeat,
      collect: async () =>
        snapshot({
          capturedAt: new Date(f.now()),
          cpuPercent: available ? 5 : null,
          memory: null,
          temperatures: [],
          unavailable: ['memory', 'temperature'],
        }),
    },
  });
  await f.runtime.start();
  assert.equal(calls, 1);
  assert.equal(f.logs.at(-1).event, 'external_heartbeat_failed');
  assert.ok(!JSON.stringify(f.logs).includes(endpoint));
  available = false;
  f.advance();
  await f.jobs[0].task();
  available = true;
  f.gateway.isReady = () => false;
  f.advance();
  await f.jobs[0].task();
  assert.equal(calls, 1);
  assert.equal(f.runtime.ready, false);
});

test('shutdown stops scheduling immediately, drains in-flight delivery, then flushes and closes before disconnecting', async (t) => {
  const f = await fixture(t);
  await f.runtime.start();
  const gate = deferred();
  const entered = deferred();
  f.reporter.send = async () => {
    f.events.push('send-enter');
    entered.resolve();
    await gate.promise;
    f.events.push('send-done');
  };
  f.archive.close = async () => {
    f.events.push('reader-close');
  };
  const flush = f.telemetry.flush.bind(f.telemetry);
  f.telemetry.flush = () => {
    f.events.push('flush');
    flush();
  };
  const close = f.telemetry.close.bind(f.telemetry);
  f.telemetry.close = () => {
    f.events.push('close');
    close();
  };
  const pending = f.jobs[1].task();
  await entered.promise;
  const stopped = f.runtime.stop();
  assert.equal(f.runtime.ready, false);
  assert.ok(f.jobs.every((job) => job.stopped));
  assert.equal(f.events.includes('close'), false);
  assert.equal(f.events.includes('destroy'), false);
  assert.equal(await f.runtime.dispatch(f.interaction('stats')), false);
  gate.resolve();
  await Promise.all([pending, stopped]);
  assert.deepEqual(f.events.slice(-5), ['send-done', 'reader-close', 'flush', 'close', 'destroy']);
  await f.runtime.stop();
  assert.equal(f.events.filter((event) => event === 'close').length, 1);
});

test('shutdown during collection drains it without writing or sending after storage closes', async (t) => {
  const gate = deferred();
  const entered = deferred();
  const f = await fixture(t, {
    options: {
      collect: async () => {
        entered.resolve();
        await gate.promise;
        return snapshot();
      },
    },
  });
  const started = f.runtime.start();
  await entered.promise;
  const stopped = f.runtime.stop();
  gate.resolve();
  await Promise.all([started, stopped]);
  assert.equal(f.sent.length, 0);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.events.at(-1), 'destroy');
});

test('recognized guild slash commands are durably audited for success, denial, cooldown and failure', async (t) => {
  const f = await fixture(t);
  await f.runtime.start();
  const success = f.interaction('about');
  await f.runtime.dispatch(success);
  const cooldown = f.interaction('stats');
  await f.runtime.dispatch(cooldown);
  const denied = f.interaction('audit');
  denied.user.id = '1562643787510063290';
  await f.runtime.dispatch(denied);
  const failed = f.interaction('stats');
  failed.user.id = '1562643787510063291';
  failed.editReply = async () => {
    throw new Error('private-fixture-message');
  };
  await f.runtime.dispatch(failed);
  const entries = f.telemetry.recentCommands();
  const outcome = (request) => entries.find((entry) => entry.id === request.id);
  assert.equal(outcome(success).outcome, 'ok');
  assert.equal(outcome(cooldown).outcome, 'cooldown');
  assert.equal(outcome(denied).outcome, 'denied');
  assert.equal(outcome(failed).outcome, 'failed');
  assert.equal(outcome(success).startedAt, success.createdTimestamp);
  assert.ok(outcome(success).finishedAt >= success.createdTimestamp);
  assert.ok(outcome(success).durationMs >= 0);
  assert.ok(!JSON.stringify(f.logs).includes('private-fixture-message'));
  assert.equal(denied.calls[0][1].flags, MessageFlags.Ephemeral);
  const foreign = f.interaction('stats');
  foreign.guildId = '1562082957022204007';
  await f.runtime.dispatch(foreign);
  assert.equal(await f.runtime.dispatch(f.interaction('other-command')), false);
  assert.equal(f.telemetry.status().commandCount, 4);
});

test('failed owner interactions keep private replies and audit errors do not disable the command handler', async (t) => {
  const f = await fixture(t);
  await f.runtime.start();
  f.telemetry.startCommand = () => {
    throw new Error('audit disk problem');
  };
  f.telemetry.finishCommand = () => {
    throw new Error('audit disk problem');
  };
  f.reporter.send = async () => {
    throw new Error('private send failure');
  };
  const request = f.interaction('snapshot');
  await f.runtime.dispatch(request);
  assert.equal(request.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.equal(request.calls[1][0], 'edit');
  assert.match(request.calls[1][1].embeds[0].toJSON().title, /Command failed/);
  assert.equal(f.logs.filter((entry) => entry.event === 'command_audit_failed').length, 2);
  assert.equal(f.runtime.reports.failures, 1);
});

test('an application ID mismatch or failed registration does not start reporting or background work', async (t) => {
  const mismatch = await fixture(t);
  mismatch.gateway.applicationId = () => '1562643787510063299';
  await assert.rejects(mismatch.runtime.start(), { name: 'ApplicationIdMismatch' });
  assert.equal(mismatch.jobs.length, 0);
  assert.equal(mismatch.sent.length, 0);
  assert.equal(mismatch.runtime.ready, false);
  const failed = await fixture(t);
  failed.gateway.register = async () => {
    throw new Error('fixture registration failure');
  };
  await assert.rejects(failed.runtime.start(), /registration failure/);
  assert.equal(failed.jobs.length, 0);
  assert.equal(failed.telemetry.status().metricCount, 0);
});

test('startup and hourly audit maintenance expire old command records while metrics persist', async (t) => {
  const f = await fixture(t);
  f.telemetry.recordMetrics([
    { at: f.now() - 400 * 86400_000, cpu: 1, memory: 2, temperature: 30 },
  ]);
  f.telemetry.startCommand({
    id: 'old',
    command: 'stats',
    actorId: '123',
    guildId: config().guildId,
    channelId: null,
    startedAt: f.now() - 91 * 86400_000,
  });
  f.telemetry.finishCommand('old', 'ok');
  await f.runtime.start();
  assert.equal(f.telemetry.status().commandCount, 0);
  assert.equal(f.telemetry.status().metricCount, 2);
  assert.ok(f.logs.some((entry) => entry.event === 'audit_records_expired' && entry.records === 1));
  f.telemetry.startCommand({
    id: 'late-backfill',
    command: 'stats',
    actorId: '123',
    guildId: config().guildId,
    channelId: null,
    startedAt: f.now() - 91 * 86400_000,
  });
  for (let i = 0; i < 60; i++) f.advance();
  await f.jobs[0].task();
  assert.equal(f.telemetry.status().commandCount, 0);
  assert.equal(f.telemetry.status().metricCount, 3);
});

test('failed audit cleanup backs off for fifteen minutes while sampling continues, then returns to hourly cadence', async (t) => {
  const f = await fixture(t);
  const prune = f.telemetry.pruneCommands.bind(f.telemetry);
  let attempts = 0;
  let failing = true;
  f.telemetry.pruneCommands = (...args) => {
    attempts++;
    if (failing) throw new Error('fixture storage failure');
    return prune(...args);
  };
  await f.runtime.start();
  assert.equal(attempts, 1);
  for (let i = 0; i < 14; i++) {
    f.advance();
    await f.jobs[0].task();
  }
  assert.equal(attempts, 1);
  assert.equal(f.telemetry.status().metricCount, 15);
  f.advance();
  await f.jobs[0].task();
  assert.equal(attempts, 2);
  assert.equal(f.logs.filter((e) => e.event === 'audit_retention_failed').length, 2);
  failing = false;
  for (let i = 0; i < 15; i++) f.advance();
  await f.jobs[0].task();
  assert.equal(attempts, 3);
  for (let i = 0; i < 59; i++) f.advance();
  await f.jobs[0].task();
  assert.equal(attempts, 3);
  f.advance();
  await f.jobs[0].task();
  assert.equal(attempts, 4);
});

test('public exporting receives host readings, and export failure does not stop alerts or sampling', async (t) => {
  const published = [];
  const f = await fixture(t, {
    options: {
      publisher: {
        publish: async (value) => {
          published.push(value);
          throw new Error('export failed');
        },
      },
    },
  });
  await f.runtime.start();
  assert.equal(published.length, 1);
  assert.equal(published[0].cpuPercent, 5);
  assert.ok(f.logs.some((entry) => entry.event === 'dashboard_export_failed'));
  assert.equal(f.runtime.ready, true);
  assert.ok(f.sent.length > 0, 'Discord delivery survives projection failure');
  await f.runtime.sample();
  assert.equal(published.length, 2);
});

test('a slow public export never delays the heartbeat or the Discord activity', async (t) => {
  let pings = 0;
  const heartbeat = new ExternalHeartbeat('https://example.invalid/fixture', async () => {
    pings++;
    return new Response(null, { status: 200 });
  });
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    config: { HEARTBEAT_URL: 'https://example.invalid/fixture' },
    options: {
      heartbeat,
      publisher: {
        publish: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    },
  });
  const started = f.runtime.start();
  try {
    await entered.promise;
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pings, 1, 'the heartbeat must not wait for the archive query behind the export');
    assert.ok(f.events.includes('activity'));
  } finally {
    // Always unblock the export so a failing assertion cannot hang the runtime teardown.
    release.resolve();
  }
  await started;
  assert.equal(f.sent.length, 1, 'startup still completes once the export finishes');
});

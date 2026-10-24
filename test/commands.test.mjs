import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { commandDefinitions, handleCommand } from '../dist/commands.js';
import { Cooldown, ReportControls } from '../dist/controls.js';
import { History } from '../dist/history.js';
import { MetricsCache } from '../dist/monitoring.js';
import { config, ownerId, snapshot } from './fixtures.mjs';

function harness(settings = {}) {
  const configuration = config(settings);
  const events = [];
  const sent = [];
  const context = {
    config: configuration, history: new History(), reports: new ReportControls(),
    cache: new MetricsCache(async () => { events.push('read'); return snapshot({ capturedAt: new Date() }); }),
    reporter: { send: async (embed) => { events.push('send'); sent.push(embed.toJSON()); } },
    cooldown: new Cooldown(10_000), manualCooldown: new Cooldown(60_000, 1),
    gatewayPing: () => 42,
  };
  function interaction(commandName = 'optiplex', subcommand = 'stats', options = {}) {
    const calls = [];
    return {
      commandName, guildId: configuration.guildId, user: { id: ownerId },
      memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
      options: { getSubcommand: () => subcommand, getInteger: (key) => options[key] ?? null },
      calls,
      reply: async (payload) => { events.push('reply'); calls.push(['reply', payload]); },
      deferReply: async (payload) => { events.push('defer'); calls.push(['defer', payload]); },
      editReply: async (payload) => { events.push('edit'); calls.push(['edit', payload]); },
    };
  }
  return { context, events, sent, interaction };
}

test('command registration exposes a bounded set of options and defaults owner commands to restricted', () => {
  const definitions = commandDefinitions().map((command) => command.toJSON());
  assert.deepEqual(definitions.map((command) => command.name), ['about', 'optiplex', 'optiplex-admin']);
  const admin = definitions[2];
  assert.equal(admin.default_member_permissions, '0');
  assert.deepEqual(admin.options.map((sub) => sub.name), ['diagnostics', 'snapshot', 'pause', 'resume']);
  const pause = admin.options.find((sub) => sub.name === 'pause').options[0];
  assert.equal(pause.min_value, 5);
  assert.equal(pause.max_value, 1440);
  const hours = definitions[1].options.find((sub) => sub.name === 'history').options[0];
  assert.deepEqual(hours.choices.map((choice) => choice.value), [1, 6, 24]);
});

test('owner authorization fails closed even when the caller has Discord Administrator', async () => {
  for (const settings of [{}, { ADMIN_ID: '' }]) {
    for (const subcommand of ['diagnostics', 'snapshot', 'pause', 'resume']) {
      const { context, interaction, events, sent } = harness(settings);
      const request = interaction('optiplex-admin', subcommand);
      request.user.id = '1562643787510063219';
      assert.equal(request.memberPermissions.has(PermissionFlagsBits.Administrator), true);
      await handleCommand(request, context);
      assert.deepEqual(events, ['reply']);
      assert.equal(request.calls[0][1].flags, MessageFlags.Ephemeral);
      assert.deepEqual(request.calls[0][1].allowedMentions, { parse: [] });
      assert.equal(context.reports.isPaused(), false);
      assert.equal(context.cache.last, null);
      assert.equal(sent.length, 0);
    }
  }
  const { context, interaction, events } = harness({ ADMIN_ID: '' });
  await handleCommand(interaction('optiplex-admin', 'diagnostics'), context);
  assert.deepEqual(events, ['reply'], 'the intended owner is denied too when ADMIN_ID is blank');
});

test('guild and DM checks run before metrics or owner controls', async () => {
  for (const guildId of [null, '1562082957022204007']) {
    for (const command of ['about', 'optiplex', 'optiplex-admin']) {
      const { context, interaction, events } = harness();
      const request = interaction(command, command === 'optiplex-admin' ? 'pause' : 'stats');
      request.guildId = guildId;
      await handleCommand(request, context);
      assert.deepEqual(events, ['reply']);
      assert.equal(request.calls[0][1].flags, MessageFlags.Ephemeral);
      assert.equal(context.reports.isPaused(), false);
    }
  }
});

test('live stats acknowledge before collecting and commands do not add history samples', async () => {
  const { context, interaction, events } = harness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  context.cache = new MetricsCache(async () => {
    events.push('read');
    await gate;
    return snapshot();
  });
  const request = interaction();
  const pending = handleCommand(request, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['defer', 'read']);
  release();
  assert.equal(await pending, true);
  assert.deepEqual(events, ['defer', 'read', 'edit']);
  assert.deepEqual(request.calls[0][1], {});
  assert.equal(context.history.size, 0);
});

test('about, help, history and Discord ping work without host readings', async () => {
  for (const [command, subcommand] of [['about', ''], ['optiplex', 'help'],
    ['optiplex', 'history'], ['optiplex', 'ping']]) {
    const { context, interaction, events } = harness();
    const request = interaction(command, subcommand);
    await handleCommand(request, context);
    assert.deepEqual(events, ['defer', 'edit']);
    assert.deepEqual(request.calls[1][1].allowedMentions, { parse: [] });
  }
});

test('every owner reply is private and only the explicit snapshot command posts publicly', async () => {
  for (const subcommand of ['diagnostics', 'snapshot', 'pause', 'resume']) {
    const { context, interaction, sent } = harness();
    const request = interaction('optiplex-admin', subcommand);
    await handleCommand(request, context);
    assert.equal(request.calls[0][0], 'defer');
    assert.equal(request.calls[0][1].flags, MessageFlags.Ephemeral);
    assert.deepEqual(request.calls[1][1].allowedMentions, { parse: [] });
    assert.equal(sent.length, subcommand === 'snapshot' ? 1 : 0);
    if (subcommand === 'snapshot') {
      assert.ok(context.reports.lastReportAt);
      assert.match(request.calls[1][1].embeds[0].toJSON().description, new RegExp(context.config.channelId));
    }
    if (subcommand === 'pause') {
      assert.equal(context.reports.isPaused(), true);
      assert.match(request.calls[1][1].embeds[0].toJSON().description, /thermal alerts continue/);
    }
  }
});

test('the global manual-post cooldown prevents channel spam without disabling the scheduler', async () => {
  const { context, interaction, sent } = harness();
  context.cooldown = new Cooldown(0);
  await handleCommand(interaction('optiplex-admin', 'snapshot'), context);
  const second = interaction('optiplex-admin', 'snapshot');
  await handleCommand(second, context);
  assert.equal(sent.length, 1);
  assert.match(second.calls[1][1].embeds[0].toJSON().title, /cooldown/);
  assert.equal(context.reports.isPaused(), false);
});

test('per-user command cooldowns do not block other users', async () => {
  const { context, interaction, events } = harness();
  await handleCommand(interaction('optiplex', 'help'), context);
  const repeated = interaction('optiplex', 'stats');
  await handleCommand(repeated, context);
  assert.equal(repeated.calls[0][0], 'reply');
  assert.equal(repeated.calls[0][1].flags, MessageFlags.Ephemeral);
  const other = interaction('optiplex', 'stats');
  other.user.id = '1562643787510063219';
  await handleCommand(other, context);
  assert.equal(other.calls[0][0], 'defer');
  assert.equal(events.filter((event) => event === 'read').length, 1);
});

test('a failed forced post records a failure without claiming success', async () => {
  const { context, interaction } = harness();
  context.reporter.send = async () => { throw new Error('fixture permission failure'); };
  const request = interaction('optiplex-admin', 'snapshot');
  await assert.rejects(handleCommand(request, context), /fixture permission failure/);
  assert.equal(context.reports.lastReportAt, null);
  assert.equal(context.reports.failures, 1);
  assert.deepEqual(request.calls.map(([method]) => method), ['defer']);
});

test('unknown commands are ignored instead of acknowledging another handler’s command', async () => {
  const { context, interaction, events } = harness();
  assert.equal(await handleCommand(interaction('another-bot-command'), context), false);
  assert.deepEqual(events, []);
});

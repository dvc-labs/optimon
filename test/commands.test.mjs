import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { commandDefinitions, registerCommands, handleCommand } from '../dist/commands.js';
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
  function interaction(commandName = 'stats', options = {}) {
    const calls = [];
    return {
      commandName, guildId: configuration.guildId, user: { id: ownerId },
      memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
      options: { getInteger: (key) => options[key] ?? null },
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
  assert.deepEqual(definitions.map((command) => command.name), [
    'about', 'stats', 'uptime', 'history', 'ping', 'vibe', 'help',
    'diagnostics', 'snapshot', 'pause', 'resume',
  ]);
  const ownerNames = ['diagnostics', 'snapshot', 'pause', 'resume'];
  for (const definition of definitions) {
    if (ownerNames.includes(definition.name)) assert.equal(definition.default_member_permissions, '0');
    else assert.equal(definition.default_member_permissions, undefined);
    assert.ok(!definition.options.some((option) => option.type === 1 || option.type === 2),
      'all commands must be directly invokable without a subcommand or group');
  }
  const pause = definitions.find((command) => command.name === 'pause').options[0];
  assert.equal(pause.min_value, 5);
  assert.equal(pause.max_value, 1440);
  const hours = definitions.find((command) => command.name === 'history').options[0];
  assert.deepEqual(hours.choices.map((choice) => choice.value), [1, 6, 24]);
});

test('registration retires only the old slash-command groups and is safe to repeat', async () => {
  const guildId = config().guildId;
  const registered = new Map([
    ['old-public', { id: 'old-public', name: 'optiplex', type: ApplicationCommandType.ChatInput }],
    ['old-owner', { id: 'old-owner', name: 'optiplex-admin', type: ApplicationCommandType.ChatInput }],
    ['other', { id: 'other', name: 'another-command', type: ApplicationCommandType.ChatInput }],
    ['context', { id: 'context', name: 'optiplex', type: ApplicationCommandType.User }],
  ]);
  const created = [];
  const deleted = [];
  const manager = {
    create: async (definition, guild) => {
      assert.equal(guild, guildId);
      created.push(definition.name);
    },
    fetch: async (options) => { assert.deepEqual(options, { guildId }); return registered; },
    delete: async (id, guild) => {
      assert.equal(guild, guildId);
      assert.equal(created.length, 11, 'register every replacement before retiring the old groups');
      deleted.push(id);
      registered.delete(id);
    },
  };
  await registerCommands(manager, guildId);
  assert.deepEqual(deleted, ['old-public', 'old-owner']);
  assert.equal(registered.has('other'), true);
  assert.equal(registered.has('context'), true);
  await registerCommands(manager, guildId);
  assert.equal(created.length, 22);
  assert.deepEqual(deleted, ['old-public', 'old-owner']);
});

test('failed command registration does not delete the old groups', async () => {
  let fetched = false;
  let deleted = false;
  const failure = new Error('fixture registration failure');
  await assert.rejects(registerCommands({
    create: async (definition) => { if (definition.name === 'history') throw failure; },
    fetch: async () => { fetched = true; return new Map(); },
    delete: async () => { deleted = true; },
  }, config().guildId), failure);
  assert.equal(fetched, false);
  assert.equal(deleted, false);
});

test('owner authorization fails closed even when the caller has Discord Administrator', async () => {
  for (const settings of [{}, { ADMIN_ID: '' }]) {
    for (const command of ['diagnostics', 'snapshot', 'pause', 'resume']) {
      const { context, interaction, events, sent } = harness(settings);
      const request = interaction(command);
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
  await handleCommand(interaction('diagnostics'), context);
  assert.deepEqual(events, ['reply'], 'the intended owner is denied too when ADMIN_ID is blank');
});

test('guild and DM checks run before metrics or owner controls', async () => {
  for (const guildId of [null, '1562082957022204007']) {
    for (const { name: command } of commandDefinitions().map((definition) => definition.toJSON())) {
      const { context, interaction, events } = harness();
      const request = interaction(command);
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
  for (const command of ['about', 'help', 'history', 'ping']) {
    const { context, interaction, events } = harness();
    const request = interaction(command);
    await handleCommand(request, context);
    assert.deepEqual(events, ['defer', 'edit']);
    assert.deepEqual(request.calls[1][1].allowedMentions, { parse: [] });
  }
});

test('every owner reply is private and only the explicit snapshot command posts publicly', async () => {
  for (const command of ['diagnostics', 'snapshot', 'pause', 'resume']) {
    const { context, interaction, sent } = harness();
    const request = interaction(command);
    await handleCommand(request, context);
    assert.equal(request.calls[0][0], 'defer');
    assert.equal(request.calls[0][1].flags, MessageFlags.Ephemeral);
    assert.deepEqual(request.calls[1][1].allowedMentions, { parse: [] });
    assert.equal(sent.length, command === 'snapshot' ? 1 : 0);
    if (command === 'snapshot') {
      assert.ok(context.reports.lastReportAt);
      assert.match(request.calls[1][1].embeds[0].toJSON().description, new RegExp(context.config.channelId));
    }
    if (command === 'pause') {
      assert.equal(context.reports.isPaused(), true);
      assert.match(request.calls[1][1].embeds[0].toJSON().description, /thermal alerts continue/);
    }
  }
});

test('the global manual-post cooldown prevents channel spam without disabling the scheduler', async () => {
  const { context, interaction, sent } = harness();
  context.cooldown = new Cooldown(0);
  await handleCommand(interaction('snapshot'), context);
  const second = interaction('snapshot');
  await handleCommand(second, context);
  assert.equal(sent.length, 1);
  assert.match(second.calls[1][1].embeds[0].toJSON().title, /cooldown/);
  assert.equal(context.reports.isPaused(), false);
});

test('per-user command cooldowns do not block other users', async () => {
  const { context, interaction, events } = harness();
  await handleCommand(interaction('help'), context);
  const repeated = interaction('stats');
  await handleCommand(repeated, context);
  assert.equal(repeated.calls[0][0], 'reply');
  assert.equal(repeated.calls[0][1].flags, MessageFlags.Ephemeral);
  const other = interaction('stats');
  other.user.id = '1562643787510063219';
  await handleCommand(other, context);
  assert.equal(other.calls[0][0], 'defer');
  assert.equal(events.filter((event) => event === 'read').length, 1);
});

test('a failed forced post records a failure without claiming success', async () => {
  const { context, interaction } = harness();
  context.reporter.send = async () => { throw new Error('fixture permission failure'); };
  const request = interaction('snapshot');
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

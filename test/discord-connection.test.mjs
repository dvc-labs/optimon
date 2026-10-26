import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'discord.js';
import { DiscordConnection, DiscordClientSlot } from '../dist/discord-connection.js';

function fixture(t, overrides = {}, pause = async () => {}) {
  const logs = [];
  let logins = 0;
  let destroys = 0;
  let setups = 0;
  const waits = [];
  const adapter = {
    login: async () => {
      logins++;
    },
    destroy: async () => {
      destroys++;
    },
    isReady: () => true,
    prepare: async () => {
      setups++;
    },
    ...overrides,
  };
  const connection = new DiscordConnection(
    adapter,
    (event, fields) => logs.push({ event, ...fields }),
    () => 1234,
    async (ms, signal) => {
      waits.push(ms);
      await pause(ms, signal);
    },
  );
  t.after(() => connection.stop());
  return { adapter, connection, logs, waits, counts: () => ({ logins, destroys, setups }) };
}

test('failed initial logins retry in-process with capped exponential backoff and redacted errors', async (t) => {
  let attempts = 0;
  const f = fixture(t, {
    login: async () => {
      if (++attempts <= 9) throw new Error('private-discord-token');
    },
  });
  await Promise.all([f.connection.start(), f.connection.start()]);
  assert.equal(attempts, 10);
  assert.deepEqual(f.waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(f.counts().destroys, 9);
  assert.equal(f.connection.status().loginFailures, 9);
  assert.ok(!JSON.stringify(f.logs).includes('private-discord-token'));
});

test('registration failures retry independently and repeated ready events never duplicate startup delivery', async (t) => {
  let attempts = 0;
  const f = fixture(t, {
    prepare: async () => {
      if (++attempts < 3) throw new Error('transient');
    },
  });
  await f.connection.start();
  await Promise.all([f.connection.ready(), f.connection.ready()]);
  await f.connection.ready();
  assert.equal(attempts, 3);
  assert.deepEqual(f.waits, [1000, 2000]);
  assert.equal(f.connection.status().registrationFailures, 2);
  f.connection.disconnected(1006, 0);
  f.connection.reconnecting(0);
  f.connection.resumed(0, 8);
  const status = f.connection.status();
  assert.equal(status.reconnects, 1);
  assert.equal(status.lastDisconnectAt, 1234);
  assert.equal(status.lastResumeAt, 1234);
  assert.ok(f.logs.some((entry) => entry.event === 'discord_disconnected' && entry.code === 1006));
  assert.ok(f.logs.some((entry) => entry.event === 'discord_resumed' && entry.replayed === 8));
});

test('shutdown cancels a pending retry without another login or an unhandled rejection', async (t) => {
  let entered;
  const retrying = new Promise((resolve) => {
    entered = resolve;
  });
  let attempts = 0;
  const f = fixture(
    t,
    {
      login: async () => {
        attempts++;
        throw new Error('offline');
      },
    },
    async (_, signal) => {
      entered();
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    },
  );
  const pending = f.connection.start();
  await retrying;
  await f.connection.stop();
  await pending;
  await f.connection.ready();
  assert.equal(attempts, 1);
  assert.equal(f.connection.status().connected, false);
});

test('a disconnect during setup recovers on session resume without another ready event', async (t) => {
  let connected = true;
  let setups = 0;
  const f = fixture(
    t,
    {
      isReady: () => connected,
      prepare: async () => {
        if (++setups === 1) connected = false;
      },
    },
    async () => {
      assert.equal(f.connection.prepared, false);
      connected = true;
      f.connection.resumed(0, 0);
    },
  );
  await f.connection.ready();
  assert.equal(setups, 2);
  assert.equal(f.connection.prepared, true);
  assert.equal(f.logs.filter((entry) => entry.event === 'discord_ready').length, 1);
});

test('initial command setup survives an offline retry boundary and resumes without a new ClientReady', async (t) => {
  let connected = true;
  let attempts = 0;
  const f = fixture(
    t,
    {
      isReady: () => connected,
      prepare: async () => {
        if (++attempts === 1) {
          connected = false;
          throw new Error('gateway disconnected during registration');
        }
      },
    },
    async () => {
      if (f.waits.length === 2) {
        connected = true;
        f.connection.resumed(0, 0);
      }
    },
  );
  await f.connection.ready();
  assert.equal(attempts, 2);
  assert.deepEqual(f.waits, [1000, 2000]);
  assert.equal(
    f.connection.status().registrationFailures,
    1,
    'waiting offline is not another setup failure',
  );
  assert.equal(f.connection.prepared, true);
  await f.connection.ready();
  assert.equal(attempts, 2, 'successful setup is still performed only once');
});

test('shutdown cancels unfinished setup while the gateway remains disconnected', async (t) => {
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture(t, { isReady: () => false }, async (_, signal) => {
    entered();
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  });
  const pending = f.connection.ready();
  await waiting;
  await f.connection.stop();
  await pending;
  assert.equal(f.connection.prepared, false);
  assert.equal(f.counts().setups, 0);
});

test('a failed real discord.js client is replaced before retrying login, with no network calls', async (t) => {
  const made = [];
  const attached = [];
  const clients = new DiscordClientSlot(
    () => {
      const client = new Client({ intents: [] });
      made.push(client);
      client.ws.connect = async () => {
        if (made.length === 1) throw new Error('simulated gateway failure');
      };
      return client;
    },
    (client) => attached.push(client),
  );
  const connection = new DiscordConnection(
    {
      login: () => clients.login('fixture-token'),
      destroy: () => clients.destroy(),
      isReady: () => clients.current.isReady(),
      prepare: async () => {},
    },
    () => {},
    Date.now,
    async () => {},
  );
  t.after(() => connection.stop());
  await connection.start();
  assert.equal(made.length, 2);
  assert.equal(made[0].ws.destroyed, true, 'the SDK destroys the failed client itself');
  assert.equal(
    made[1].ws.destroyed,
    false,
    'the second attempt must have a fresh WebSocket manager',
  );
  assert.equal(clients.current.token, 'fixture-token');
  assert.deepEqual(attached, made, 'event listeners must be attached to every replacement');
});

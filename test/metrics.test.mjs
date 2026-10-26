import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCpu,
  cpuUsage,
  parseMemory,
  parseSwap,
  parseLoad,
  parseUptime,
  readTemperatures,
  collectSnapshot,
  cpuDetails,
  parseHostState,
  parseMemoryBreakdown,
  diskFromStatfs,
  readDisk,
} from '../dist/metrics.js';

test('CPU sampling excludes double-counted guest counters and includes iowait in idle', () => {
  const before = parseCpu('cpu  100 0 50 800 50 0 0 0 90 0\ncpu0 1 2 3 4\ncpu1 1 2 3 4\n');
  const after = parseCpu('cpu  120 0 60 860 60 0 0 0 100 0\ncpu0 1 2 3 4\ncpu1 1 2 3 4\n');
  assert.equal(before.total, 1000n);
  assert.equal(before.cores, 2);
  assert.equal(cpuUsage(before, after), 30);
  assert.equal(cpuUsage(before, before), null);
  assert.equal(cpuUsage(after, before), null);
});

test('memory usage uses MemAvailable, so reclaimable cache is not all counted as used', () => {
  const memory = parseMemory(
    'MemTotal: 8000000 kB\nMemFree: 1000000 kB\nMemAvailable: 6000000 kB\n',
  );
  assert.equal(memory.percent, 25);
  assert.equal(memory.total, 8000000 * 1024);
  assert.throws(() => parseMemory('MemTotal: 1 kB\nMemAvailable: 2 kB\n'));
  assert.throws(() => parseMemory('MemTotal: 8000000 kB\n'));
});

test('load averages and host uptime are parsed independently of bot uptime', () => {
  assert.deepEqual(parseLoad('0.05 0.10 0.20 1/250 1234'), [0.05, 0.1, 0.2]);
  assert.equal(parseUptime('86400.52 410000.00'), 86400.52);
  assert.throws(() => parseUptime(''));
  assert.throws(() => parseLoad('bad data'));
});

test('coretemp sensors convert millidegrees and tolerate missing labels and invalid readings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'optiplex-sensors-'));
  try {
    const cpu = join(root, 'hwmon3');
    const other = join(root, 'hwmon4');
    await mkdir(cpu);
    await mkdir(other);
    await Promise.all([
      writeFile(join(cpu, 'name'), 'coretemp\n'),
      writeFile(join(cpu, 'temp1_input'), '31000\n'),
      writeFile(join(cpu, 'temp1_label'), 'Package id 0\n'),
      writeFile(join(cpu, 'temp2_input'), '27500\n'),
      writeFile(join(cpu, 'temp3_input'), 'not a temperature\n'),
      writeFile(join(cpu, 'temp4_input'), '999999999\n'),
      writeFile(join(other, 'name'), 'not-coretemp\n'),
      writeFile(join(other, 'temp1_input'), '99000\n'),
    ]);
    assert.deepEqual(await readTemperatures(root), [
      { label: 'Package id 0', celsius: 31 },
      { label: 'temp2', celsius: 27.5 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing host mounts produce explicit unavailable metrics, never container fallbacks', async () => {
  const snapshot = await collectSnapshot('/does-not-exist/proc', '/does-not-exist/hwmon');
  assert.equal(snapshot.memory, null);
  assert.equal(snapshot.hostUptime, null);
  assert.equal(snapshot.cpuPercent, null);
  assert.equal(snapshot.load, null);
  assert.equal(snapshot.swap, null);
  assert.equal(snapshot.unavailable.length, 8);
  assert.ok(snapshot.botUptime >= 0);
});

test('swap reports usage and handles hosts with no configured swap', () => {
  const swap = parseSwap('SwapTotal: 4194304 kB\nSwapFree: 3145728 kB\n');
  assert.equal(swap.total, 4 * 1024 ** 3);
  assert.equal(swap.used, 1024 ** 3);
  assert.equal(swap.percent, 25);
  assert.deepEqual(parseSwap('SwapTotal: 0 kB\nSwapFree: 0 kB'), {
    total: 0,
    free: 0,
    used: 0,
    percent: 0,
  });
  assert.throws(() => parseSwap('SwapTotal: 1 kB\nSwapFree: 2 kB'));
  assert.throws(() => parseSwap('SwapTotal: 1 kB'));
});

test('per-core samples, iowait and steal use the same one-second counter deltas', () => {
  const before = parseCpu(
    'cpu 100 0 50 800 50 0 0 0\ncpu0 50 0 25 400 25 0 0 0\ncpu1 50 0 25 400 25 0 0 0\n',
  );
  const after = parseCpu(
    'cpu 120 0 60 860 55 0 0 5\ncpu0 60 0 30 430 25 0 0 5\ncpu1 60 0 30 430 30 0 0 0\n',
  );
  assert.deepEqual(cpuDetails(before, after), {
    iowaitPercent: 5,
    stealPercent: 5,
    perCore: [
      { id: 0, percent: 40 },
      { id: 1, percent: 30 },
    ],
  });
  const decreased = { ...after, iowait: 1n };
  assert.equal(cpuDetails(before, decreased).iowaitPercent, null);
  const hotplugged = parseCpu('cpu 120 0 60 860 55 0 0 5\ncpu2 1 0 1 100 0 0 0 0\n');
  assert.equal(cpuDetails(before, hotplugged).perCore[0].percent, null);
});

test('boot time and runnable tasks are host counters, not an invented boot count', () => {
  assert.deepEqual(parseHostState('btime 1793000000\nprocs_running 2\n'), {
    bootTime: 1793000000000,
    runnableTasks: 2,
  });
  assert.deepEqual(parseHostState('btime nope\nprocs_running -1\n'), {
    bootTime: null,
    runnableTasks: null,
  });
  assert.equal(parseMemoryBreakdown('MemFree: 10 kB\nSReclaimable: 20 kB\n').free, 10240);
  assert.equal(
    parseMemoryBreakdown('MemFree: 10 kB\nSReclaimable: 20 kB\n').reclaimableSlab,
    20480,
  );
  assert.equal(parseMemoryBreakdown('').slab, null);
});

test('disk percentages account for reserved blocks and reject impossible counters', () => {
  const disk = diskFromStatfs({ bsize: 4096n, blocks: 100n, bfree: 20n, bavail: 10n });
  assert.equal(disk.total, 409600);
  assert.equal(disk.used, 327680);
  assert.equal(disk.available, 40960);
  assert.ok(Math.abs(disk.percent - 88.88888888888889) < 0.0001);
  assert.throws(() => diskFromStatfs({ bsize: 4096n, blocks: 100n, bfree: 20n, bavail: 21n }));
});

test('an ordinary empty directory is refused instead of silently reporting the container filesystem', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'optimon-not-a-mount-'));
  try {
    await assert.rejects(readDisk(directory), /dedicated disk bind mount/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

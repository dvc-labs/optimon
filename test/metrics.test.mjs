import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCpu, cpuUsage, parseMemory, parseSwap, parseLoad, parseUptime,
  readTemperatures, collectSnapshot } from '../dist/metrics.js';

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
  const memory = parseMemory('MemTotal: 8000000 kB\nMemFree: 1000000 kB\nMemAvailable: 6000000 kB\n');
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
    await mkdir(cpu); await mkdir(other);
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
      { label: 'Package id 0', celsius: 31 }, { label: 'temp2', celsius: 27.5 },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing host mounts produce explicit unavailable metrics, never container fallbacks', async () => {
  const snapshot = await collectSnapshot('/does-not-exist/proc', '/does-not-exist/hwmon');
  assert.equal(snapshot.memory, null);
  assert.equal(snapshot.hostUptime, null);
  assert.equal(snapshot.cpuPercent, null);
  assert.equal(snapshot.load, null);
  assert.equal(snapshot.swap, null);
  assert.equal(snapshot.unavailable.length, 6);
  assert.ok(snapshot.botUptime >= 0);
});

test('swap reports usage and handles hosts with no configured swap', () => {
  const swap = parseSwap('SwapTotal: 4194304 kB\nSwapFree: 3145728 kB\n');
  assert.equal(swap.total, 4 * 1024 ** 3);
  assert.equal(swap.used, 1024 ** 3);
  assert.equal(swap.percent, 25);
  assert.deepEqual(parseSwap('SwapTotal: 0 kB\nSwapFree: 0 kB'), { total: 0, free: 0, used: 0, percent: 0 });
  assert.throws(() => parseSwap('SwapTotal: 1 kB\nSwapFree: 2 kB'));
  assert.throws(() => parseSwap('SwapTotal: 1 kB'));
});

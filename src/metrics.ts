import { opendir, readFile, readdir, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface CpuTicks {
  total: bigint;
  idle: bigint;
  iowait: bigint;
  steal: bigint;
}
export interface CpuCounters extends CpuTicks {
  cores: number;
  perCore: { id: number; ticks: CpuTicks }[];
}
export interface CpuDetails {
  iowaitPercent: number | null;
  stealPercent: number | null;
  perCore: { id: number; percent: number | null }[];
}
export interface MemoryBreakdown {
  free: number | null;
  cached: number | null;
  buffers: number | null;
  slab: number | null;
  reclaimableSlab: number | null;
  unreclaimableSlab: number | null;
  kernelStack: number | null;
  pageTables: number | null;
}
export interface Memory {
  total: number;
  available: number;
  used: number;
  percent: number;
}
export interface Swap {
  total: number;
  free: number;
  used: number;
  percent: number;
}
export interface Temperature {
  label: string;
  celsius: number;
}
export interface Snapshot {
  capturedAt: Date;
  hostUptime: number | null;
  botUptime: number;
  cpuPercent: number | null;
  cores: number | null;
  memory: Memory | null;
  swap: Swap | null;
  load: number[] | null;
  temperatures: Temperature[];
  unavailable: string[];
  bootTime: number | null;
  runnableTasks: number | null;
  cpuDetails: CpuDetails | null;
  memoryBreakdown: MemoryBreakdown | null;
  disk: Memory | null;
}

function cpuTicks(line: string | undefined): CpuTicks {
  const values = line?.trim().split(/\s+/).slice(1, 9);
  if (!values || values.length !== 8 || values.some((value) => !/^\d+$/.test(value))) {
    throw new Error('Invalid CPU counters.');
  }
  const counters = values.map((value) => BigInt(value));
  // guest and guest_nice are already included in user and nice: never add them again.
  return {
    total: counters.reduce((sum, value) => sum + value, 0n),
    idle: counters[3]! + counters[4]!,
    iowait: counters[4]!,
    steal: counters[7]!,
  };
}

export function parseCpu(text: string): CpuCounters {
  const lines = text.split('\n');
  const perCore: CpuCounters['perCore'] = [];
  const coreLines = lines.filter((value) => /^cpu\d+\s/.test(value));
  for (const line of coreLines.slice(0, 128)) {
    try {
      const id = Number(/^cpu(\d+)/.exec(line)![1]);
      if (id <= 4095) perCore.push({ id, ticks: cpuTicks(line) });
    } catch {
      // An absent/partial per-core row need not hide the aggregate reading.
    }
  }
  return {
    ...cpuTicks(lines.find((value) => /^cpu\s/.test(value))),
    cores: coreLines.length,
    perCore,
  };
}

export function cpuUsage(before: CpuTicks, after: CpuTicks): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0n || idle < 0n || idle > total) return null;
  return Math.max(0, Math.min(100, (Number(total - idle) / Number(total)) * 100));
}

export function cpuDetails(before: CpuCounters, after: CpuCounters): CpuDetails {
  const total = after.total - before.total;
  const fraction = (key: 'iowait' | 'steal'): number | null => {
    const delta = after[key] - before[key];
    // Linux documents that iowait can decrease. Such a delta is unknown, not a made-up zero.
    return total <= 0n || delta < 0n || delta > total
      ? null
      : (Number(delta) / Number(total)) * 100;
  };
  return {
    iowaitPercent: fraction('iowait'),
    stealPercent: fraction('steal'),
    perCore: after.perCore.map((core) => {
      const previous = before.perCore.find((value) => value.id === core.id);
      return { id: core.id, percent: previous ? cpuUsage(previous.ticks, core.ticks) : null };
    }),
  };
}

export function parseHostState(text: string): {
  bootTime: number | null;
  runnableTasks: number | null;
} {
  const counter = (name: string): number | null => {
    const match = new RegExp(`^${name} (\\d+)$`, 'm').exec(text);
    const value = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const boot = counter('btime');
  return {
    bootTime: boot === null || !Number.isSafeInteger(boot * 1000) ? null : boot * 1000,
    runnableTasks: counter('procs_running'),
  };
}

export function parseMemoryBreakdown(text: string): MemoryBreakdown {
  const value = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
    const bytes = match ? Number(match[1]) * 1024 : NaN;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  };
  return {
    free: value('MemFree'),
    cached: value('Cached'),
    buffers: value('Buffers'),
    slab: value('Slab'),
    reclaimableSlab: value('SReclaimable'),
    unreclaimableSlab: value('SUnreclaim'),
    kernelStack: value('KernelStack'),
    pageTables: value('PageTables'),
  };
}

export function diskFromStatfs(value: {
  bsize: bigint;
  blocks: bigint;
  bfree: bigint;
  bavail: bigint;
}): Memory {
  const { bsize, blocks, bfree, bavail } = value;
  if (
    bsize <= 0n ||
    blocks <= 0n ||
    bfree < 0n ||
    bfree > blocks ||
    bavail < 0n ||
    bavail > bfree ||
    blocks * bsize > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Invalid disk counters.');
  const total = Number(blocks * bsize);
  const used = Number((blocks - bfree) * bsize);
  const available = Number(bavail * bsize);
  // Like df: exclude filesystem blocks reserved for root from the usable denominator.
  return {
    total,
    used,
    available,
    percent: used + available ? (used / (used + available)) * 100 : 100,
  };
}

export async function readDisk(path: string): Promise<Memory> {
  const target = resolve(path);
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  const mounted = mounts.split('\n').some((line) => {
    const mount = line
      .split(' ')[4]
      ?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    return mount === target && line.split(' ')[5]?.split(',').includes('ro');
  });
  if (!mounted)
    throw new Error('An empty, dedicated disk bind mount with read-only access is required.');
  const directory = await opendir(target);
  try {
    if (await directory.read()) throw new Error('An empty, dedicated disk bind mount is required.');
  } finally {
    await directory.close();
  }
  return diskFromStatfs(await statfs(target, { bigint: true }));
}

export function parseMemory(text: string): Memory {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) values.set(match[1]!, Number(match[2]) * 1024);
  }
  const total = values.get('MemTotal');
  const available = values.get('MemAvailable');
  if (total === undefined || available === undefined || total <= 0 || available > total) {
    throw new Error('Invalid memory counters.');
  }
  const used = total - available;
  return { total, available, used, percent: (used / total) * 100 };
}

export function parseSwap(text: string): Swap {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(SwapTotal|SwapFree):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) values.set(match[1]!, Number(match[2]) * 1024);
  }
  const total = values.get('SwapTotal');
  const free = values.get('SwapFree');
  if (
    total === undefined ||
    free === undefined ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(free) ||
    free > total
  )
    throw new Error('Invalid swap counters.');
  const used = total - free;
  return { total, free, used, percent: total === 0 ? 0 : (used / total) * 100 };
}

export function hottestTemperature(snapshot: Snapshot): number | null {
  return snapshot.temperatures.length
    ? Math.max(...snapshot.temperatures.map((sensor) => sensor.celsius))
    : null;
}

export function parseUptime(text: string): number {
  const value = Number(text.trim().split(/\s+/)[0]);
  if (!Number.isFinite(value) || value < 0 || text.trim() === '')
    throw new Error('Invalid uptime.');
  return value;
}

export function parseLoad(text: string): number[] {
  const values = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid load averages.');
  }
  return values;
}

export async function readTemperatures(root: string): Promise<Temperature[]> {
  const result: Temperature[] = [];
  const directories = (await readdir(root)).filter((name) => /^hwmon\d+$/.test(name)).sort();
  for (const directory of directories) {
    const path = join(root, directory);
    if ((await readFile(join(path, 'name'), 'utf8')).trim() !== 'coretemp') continue;
    const files = (await readdir(path))
      .filter((name) => /^temp\d+_input$/.test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    for (const file of files) {
      try {
        const raw = (await readFile(join(path, file), 'utf8')).trim();
        if (!/^-?\d+$/.test(raw)) continue;
        const celsius = Number(raw) / 1000;
        if (!Number.isFinite(celsius) || celsius < -30 || celsius > 150) continue;
        const fallback = file.replace('_input', '');
        const label = await readFile(join(path, file.replace('_input', '_label')), 'utf8')
          .then((value) => value.trim().slice(0, 64))
          .catch(() => fallback);
        result.push({ label, celsius });
      } catch {
        /* One unavailable sensor must not hide the other sensors. */
      }
    }
  }
  return result.slice(0, 12);
}

export async function collectSnapshot(
  procPath: string,
  sensorPath: string,
  diskPath: string | null = null,
): Promise<Snapshot> {
  const unavailable: string[] = [];
  async function read<T>(name: string, operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch {
      unavailable.push(name);
      return null;
    }
  }
  const memoryText = readFile(join(procPath, 'meminfo'), 'utf8');
  const statText = readFile(join(procPath, 'stat'), 'utf8');
  const [cpu, memory, swap, hostUptime, load, temperatures, hostState, breakdown, disk] =
    await Promise.all([
      read('CPU usage', async () => {
        const before = parseCpu(await statText);
        await delay(1000);
        const after = parseCpu(await readFile(join(procPath, 'stat'), 'utf8'));
        const percent = cpuUsage(before, after);
        if (percent === null) throw new Error('CPU counters did not advance.');
        return { percent, cores: after.cores || null, details: cpuDetails(before, after) };
      }),
      read('Memory', async () => parseMemory(await memoryText)),
      read('Host swap', async () => parseSwap(await memoryText)),
      read('Host uptime', async () =>
        parseUptime(await readFile(join(procPath, 'uptime'), 'utf8')),
      ),
      read('Load averages', async () =>
        parseLoad(await readFile(join(procPath, 'loadavg'), 'utf8')),
      ),
      read('CPU temperatures', async () => {
        const values = await readTemperatures(sensorPath);
        if (!values.length) throw new Error('No readable coretemp sensors.');
        return values;
      }),
      read('Host boot/process counters', async () => parseHostState(await statText)),
      read('Memory breakdown', async () => parseMemoryBreakdown(await memoryText)),
      diskPath ? read('Disk space', () => readDisk(diskPath)) : Promise.resolve(null),
    ]);
  return {
    capturedAt: new Date(),
    hostUptime,
    botUptime: process.uptime(),
    cpuPercent: cpu?.percent ?? null,
    cores: cpu?.cores ?? null,
    memory,
    swap,
    load,
    temperatures: temperatures ?? [],
    unavailable,
    bootTime: hostState?.bootTime ?? null,
    runnableTasks: hostState?.runnableTasks ?? null,
    cpuDetails: cpu?.details ?? null,
    memoryBreakdown: breakdown,
    disk,
  };
}

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface CpuCounters { total: bigint; idle: bigint; cores: number }
export interface Memory { total: number; available: number; used: number; percent: number }
export interface Temperature { label: string; celsius: number }
export interface Snapshot {
  capturedAt: Date;
  hostUptime: number | null;
  botUptime: number;
  cpuPercent: number | null;
  cores: number | null;
  memory: Memory | null;
  load: number[] | null;
  temperatures: Temperature[];
  unavailable: string[];
}

export function parseCpu(text: string): CpuCounters {
  const line = text.split('\n').find((value) => /^cpu\s/.test(value));
  const values = line?.trim().split(/\s+/).slice(1, 9);
  if (!values || values.length !== 8 || values.some((value) => !/^\d+$/.test(value))) {
    throw new Error('Invalid CPU counters.');
  }
  const counters = values.map((value) => BigInt(value));
  // guest and guest_nice are already included in user and nice: never add them again.
  return {
    total: counters.reduce((sum, value) => sum + value, 0n),
    idle: counters[3]! + counters[4]!,
    cores: text.split('\n').filter((value) => /^cpu\d+\s/.test(value)).length,
  };
}

export function cpuUsage(before: CpuCounters, after: CpuCounters): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0n || idle < 0n || idle > total) return null;
  return Math.max(0, Math.min(100, Number(total - idle) / Number(total) * 100));
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
  return { total, available, used, percent: used / total * 100 };
}

export function parseUptime(text: string): number {
  const value = Number(text.trim().split(/\s+/)[0]);
  if (!Number.isFinite(value) || value < 0 || text.trim() === '') throw new Error('Invalid uptime.');
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
    const files = (await readdir(path)).filter((name) => /^temp\d+_input$/.test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    for (const file of files) {
      try {
        const raw = (await readFile(join(path, file), 'utf8')).trim();
        if (!/^-?\d+$/.test(raw)) continue;
        const celsius = Number(raw) / 1000;
        if (!Number.isFinite(celsius) || celsius < -30 || celsius > 150) continue;
        const fallback = file.replace('_input', '');
        const label = await readFile(join(path, file.replace('_input', '_label')), 'utf8')
          .then((value) => value.trim().slice(0, 64)).catch(() => fallback);
        result.push({ label, celsius });
      } catch { /* One unavailable sensor must not hide the other sensors. */ }
    }
  }
  return result.slice(0, 12);
}

export async function collectSnapshot(procPath: string, sensorPath: string): Promise<Snapshot> {
  const unavailable: string[] = [];
  async function read<T>(name: string, operation: () => Promise<T>): Promise<T | null> {
    try { return await operation(); } catch { unavailable.push(name); return null; }
  }
  const [cpu, memory, hostUptime, load, temperatures] = await Promise.all([
    read('CPU usage', async () => {
      const before = parseCpu(await readFile(join(procPath, 'stat'), 'utf8'));
      await delay(1000);
      const after = parseCpu(await readFile(join(procPath, 'stat'), 'utf8'));
      const percent = cpuUsage(before, after);
      if (percent === null) throw new Error('CPU counters did not advance.');
      return { percent, cores: after.cores || null };
    }),
    read('Memory', async () => parseMemory(await readFile(join(procPath, 'meminfo'), 'utf8'))),
    read('Host uptime', async () => parseUptime(await readFile(join(procPath, 'uptime'), 'utf8'))),
    read('Load averages', async () => parseLoad(await readFile(join(procPath, 'loadavg'), 'utf8'))),
    read('CPU temperatures', async () => {
      const values = await readTemperatures(sensorPath);
      if (!values.length) throw new Error('No readable coretemp sensors.');
      return values;
    }),
  ]);
  return {
    capturedAt: new Date(), hostUptime, botUptime: process.uptime(),
    cpuPercent: cpu?.percent ?? null, cores: cpu?.cores ?? null, memory, load,
    temperatures: temperatures ?? [], unavailable,
  };
}

/** The only data contract allowed across the public/private container boundary. */
export const PUBLIC_SCHEMA = 1;
export const PUBLIC_FILE_LIMIT = 256 * 1024;
export const PUBLIC_STALE_MS = 180_000;
export const PUBLIC_HISTORY_MS = 300_000;
export const PUBLIC_BUCKETS = 96;
export const DASHBOARD_WINDOWS = [
  { key: '1h', minutes: 60 },
  { key: '6h', minutes: 360 },
  { key: '24h', minutes: 1440 },
  { key: '7d', minutes: 10080 },
  { key: '30d', minutes: 43200 },
  { key: '365d', minutes: 525600 },
  { key: 'all', minutes: 0 },
] as const;
export interface PublicPoint {
  at: number;
  cpu: number | null;
  memory: number | null;
  temperature: number | null;
}
export interface PublicAggregate {
  count: number;
  min: number;
  mean: number;
  max: number;
}
export interface PublicWindow {
  key: string;
  from: number;
  to: number;
  count: number;
  cpu: PublicAggregate | null;
  memory: PublicAggregate | null;
  temperature: PublicAggregate | null;
  points: PublicPoint[];
}
export interface PublicHistory {
  generatedAt: number;
  firstAt: number | null;
  lastAt: number | null;
  totalSamples: number;
  windows: PublicWindow[];
}
interface PublicMemory {
  total: number;
  used: number;
  available: number;
  percent: number;
}
export interface PublicData {
  schema: 1;
  version: string;
  generatedAt: number;
  thermalWarnC: number;
  thermalRecoverC: number;
  live: {
    capturedAt: number;
    hostUptime: number | null;
    botUptime: number;
    cpuPercent: number | null;
    cores: number | null;
    memory: PublicMemory | null;
    swap: PublicMemory | null;
    load: number[] | null;
    temperatures: { label: string; celsius: number }[];
  };
  history: PublicHistory | null;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('InvalidPublicData');
  return value as Record<string, unknown>;
}
function numeric(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error('InvalidPublicData');
  return value;
}
function nullable(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return value === null ? null : numeric(value, min, max);
}
function memory(value: unknown): PublicMemory | null {
  if (value === null) return null;
  const v = object(value);
  const total = numeric(v.total);
  return {
    total,
    used: numeric(v.used, 0, total),
    available: numeric(v.available, 0, total),
    percent: numeric(v.percent, 0, 100),
  };
}
function aggregate(value: unknown, min: number, max: number): PublicAggregate | null {
  if (value === null) return null;
  const v = object(value);
  return {
    count: numeric(v.count),
    min: numeric(v.min, min, max),
    mean: numeric(v.mean, min, max),
    max: numeric(v.max, min, max),
  };
}
/** Reconstruct, never forward arbitrary properties from the writer or a future schema. */
export function parsePublicHistory(value: unknown): PublicHistory {
  const v = object(value);
  if (!Array.isArray(v.windows) || v.windows.length !== DASHBOARD_WINDOWS.length)
    throw new Error('InvalidPublicData');
  return {
    generatedAt: numeric(v.generatedAt),
    firstAt: nullable(v.firstAt),
    lastAt: nullable(v.lastAt),
    totalSamples: numeric(v.totalSamples),
    windows: v.windows.map((raw, index) => {
      const w = object(raw);
      if (
        w.key !== DASHBOARD_WINDOWS[index]!.key ||
        !Array.isArray(w.points) ||
        w.points.length !== PUBLIC_BUCKETS
      )
        throw new Error('InvalidPublicData');
      return {
        key: DASHBOARD_WINDOWS[index]!.key,
        from: numeric(w.from),
        to: numeric(w.to),
        count: numeric(w.count),
        cpu: aggregate(w.cpu, 0, 100),
        memory: aggregate(w.memory, 0, 100),
        temperature: aggregate(w.temperature, -30, 150),
        points: w.points.map((rawPoint) => {
          const p = object(rawPoint);
          return {
            at: numeric(p.at),
            cpu: nullable(p.cpu, 0, 100),
            memory: nullable(p.memory, 0, 100),
            temperature: nullable(p.temperature, -30, 150),
          };
        }),
      };
    }),
  };
}
export function parsePublicData(value: unknown): PublicData {
  const v = object(value);
  const live = object(v.live);
  if (
    v.schema !== PUBLIC_SCHEMA ||
    typeof v.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(v.version) ||
    !Array.isArray(live.temperatures) ||
    live.temperatures.length > 12
  )
    throw new Error('InvalidPublicData');
  if (live.load !== null && (!Array.isArray(live.load) || live.load.length !== 3))
    throw new Error('InvalidPublicData');
  return {
    schema: PUBLIC_SCHEMA,
    version: v.version,
    generatedAt: numeric(v.generatedAt),
    thermalWarnC: numeric(v.thermalWarnC, 0, 150),
    thermalRecoverC: numeric(v.thermalRecoverC, 0, 150),
    live: {
      capturedAt: numeric(live.capturedAt),
      hostUptime: nullable(live.hostUptime),
      botUptime: numeric(live.botUptime),
      cpuPercent: nullable(live.cpuPercent, 0, 100),
      cores: nullable(live.cores, 1, 4096),
      memory: memory(live.memory),
      swap: memory(live.swap),
      load: live.load === null ? null : (live.load as unknown[]).map((n) => numeric(n)),
      temperatures: live.temperatures.map((raw) => {
        const t = object(raw);
        if (typeof t.label !== 'string' || !/^(Package id \d+|Core \d+|temp\d+)$/.test(t.label))
          throw new Error('InvalidPublicData');
        return { label: t.label, celsius: numeric(t.celsius, -30, 150) };
      }),
    },
    history: v.history === null ? null : parsePublicHistory(v.history),
  };
}

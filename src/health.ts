import { readFileSync } from 'node:fs';

export const HEALTH_PATH = '/tmp/optiplex-health.json';

export function isHealthy(record: unknown, now = Date.now()): boolean {
  if (
    typeof record !== 'object' ||
    record === null ||
    !('ready' in record) ||
    record.ready !== true ||
    !('updatedAt' in record) ||
    typeof record.updatedAt !== 'number'
  )
    return false;
  const age = now - record.updatedAt;
  return Number.isFinite(age) && age >= -5000 && age < 90_000;
}

export function checkHealth(): boolean {
  try {
    return isHealthy(JSON.parse(readFileSync(HEALTH_PATH, 'utf8')));
  } catch {
    return false;
  }
}

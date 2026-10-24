// Discord errors can contain request bodies and bot tokens.
// Deliberately log only selected diagnostic identifiers, never the raw error.
export function safeError(error: unknown): Record<string, string | number> {
  const result: Record<string, string | number> = { kind: 'UnknownError' };
  if (typeof error !== 'object' || error === null) return result;
  for (const key of ['name', 'code', 'status', 'errcode'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) result[key] = value;
  }
  return result;
}

export function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

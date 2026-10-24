import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

export interface DashboardConfig {
  host: string;
  port: number;
  publicUrl: string;
  dataFile: string;
  assetPath: string;
  tls: { cert: string; key: string; ca: string } | null;
}
export function loadDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const publicUrl = new URL(env.DASHBOARD_PUBLIC_URL || 'https://dashboard.davevancauwenberghe.be');
  if (
    publicUrl.protocol !== 'https:' ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== '/' ||
    publicUrl.search ||
    publicUrl.hash
  )
    throw new Error(
      'DASHBOARD_PUBLIC_URL must be an HTTPS origin without credentials, path or query.',
    );
  const port = Number(env.DASHBOARD_PORT || '3443');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid DASHBOARD_PORT.');
  // Loopback unless asked otherwise: a bare `npm run dashboard` must never serve plain HTTP on
  // every interface. Compose sets 0.0.0.0 because the published port is bound to host loopback.
  const host = env.DASHBOARD_BIND?.trim() || '127.0.0.1';
  if (!isIP(host)) throw new Error('DASHBOARD_BIND must be an IPv4 or IPv6 address.');
  const dataPath = env.PUBLIC_DATA_PATH || resolve('public-data');
  if (!isAbsolute(dataPath)) throw new Error('PUBLIC_DATA_PATH must be absolute.');
  const paths = [env.DASHBOARD_TLS_CERT, env.DASHBOARD_TLS_KEY, env.DASHBOARD_TLS_CA];
  if (paths.some(Boolean) && !paths.every((p) => p && isAbsolute(p)))
    throw new Error(
      'Set all three absolute DASHBOARD_TLS_CERT, DASHBOARD_TLS_KEY and DASHBOARD_TLS_CA paths.',
    );
  return {
    host,
    port,
    publicUrl: publicUrl.origin,
    dataFile: resolve(dataPath, 'metrics.json'),
    assetPath: resolve('web'),
    tls: paths.every(Boolean) ? { cert: paths[0]!, key: paths[1]!, ca: paths[2]! } : null,
  };
}

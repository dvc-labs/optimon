import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { loadDashboardAssets, matchesTag, publicHeaders } from './dashboard-assets.js';
import { loadDashboardConfig } from './dashboard-config.js';

export function loadFallbackConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.FALLBACK_BIND || '127.0.0.1';
  const port = Number(env.FALLBACK_PORT || '8080');
  if (!isIP(host)) throw new Error('Invalid FALLBACK_BIND.');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid FALLBACK_PORT.');
  // Reuse canonical-URL validation, with no data or TLS environment passed to the fallback.
  const { publicUrl } = loadDashboardConfig({
    DASHBOARD_PUBLIC_URL: env.DASHBOARD_PUBLIC_URL || '',
  });
  return { host, port, publicUrl, assetPath: resolve('web') };
}

export async function createFallback(config: ReturnType<typeof loadFallbackConfig>) {
  const { staticAssets, assetVersion } = await loadDashboardAssets(config, true);
  function send(
    response: ServerResponse,
    method: string,
    status: number,
    type: string,
    body: string | Buffer,
    cache = 'no-store',
    etag?: string,
  ) {
    response.writeHead(status, {
      ...publicHeaders('fallback'),
      'X-Optimon-Fallback': '1',
      'Cache-Control': cache,
      ...(etag ? { ETag: etag } : {}),
      ...(status === 304
        ? {}
        : { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }),
    });
    response.end(method === 'HEAD' || status === 304 ? undefined : body);
  }
  function handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method || '';
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(response, method, 405, 'text/plain', 'Method not allowed');
      return;
    }
    const target = request.url || '';
    if (target.length > 2048) {
      send(response, method, 414, 'text/plain', 'URI too long');
      return;
    }
    const split = target.indexOf('?');
    const path = split < 0 ? target : target.slice(0, split);
    if (path === '/healthz') {
      send(response, method, 200, 'application/json', '{"ok":true,"mode":"fallback"}');
      return;
    }
    if (['/api/live', '/api/metrics', '/api/history'].includes(path)) {
      send(
        response,
        method,
        503,
        'application/json',
        '{"status":{"state":"unavailable","reason":"origin_unreachable"},"data":null}',
      );
      return;
    }
    if (path === '/robots.txt') {
      send(response, method, 200, 'text/plain', 'User-agent: *\nDisallow: /\n');
      return;
    }
    const asset = staticAssets.get(path);
    if (!asset) {
      send(response, method, 404, 'text/plain', 'Not found');
      return;
    }
    const version = split < 0 ? null : new URLSearchParams(target.slice(split + 1)).get('v');
    const cache =
      asset.policy === 'page'
        ? 'no-store'
        : asset.policy === 'versioned' && version === assetVersion
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300';
    // The offline document is always a full response; an older online HTML ETag cannot win.
    if (asset.policy !== 'page' && matchesTag(request.headers['if-none-match'], asset.etag))
      send(response, method, 304, asset.type, '', cache, asset.etag);
    else send(response, method, 200, asset.type, asset.body, cache, asset.etag);
  }
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 10_000, keepAliveTimeout: 5000 },
    handle,
  );
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 40;
  return server;
}

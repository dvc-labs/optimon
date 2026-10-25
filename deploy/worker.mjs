// A Worker ROUTE in front of the existing Tunnel CNAME, not a Custom Domain.
// No credentials, metrics storage or Cloudflare API calls are needed at runtime.
const DEFAULT_TIMEOUT_MS = 2500;
const FALLBACK_TIMEOUT_MS = 2500;
const MAX_BODY_BYTES = 1024 * 1024;
const API_PATHS = new Set(['/api/live', '/api/metrics', '/api/history']);
const PUBLIC_PATHS = new Set(['/', '/healthz', '/robots.txt', '/favicon.svg', ...API_PATHS]);

function origin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('InvalidOrigin');
  return url.origin;
}

function safeHeaders(request) {
  const headers = new Headers();
  headers.set('Accept-Encoding', 'identity');
  for (const name of ['Accept', 'If-None-Match', 'If-Modified-Since']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function boundedBody(response, signal) {
  if (Number(response.headers.get('Content-Length')) > MAX_BODY_BYTES)
    throw new Error('ResponseTooLarge');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('ResponseTooLarge');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  if (signal.aborted) throw new Error('OriginTimeout');
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The deadline covers headers AND body; even an uncooperative upstream cannot stall failover. */
async function fetchOrigin(fetcher, request, address, timeoutMs, conditional = true) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('OriginTimeout'));
    }, timeoutMs);
  });
  const headers = safeHeaders(request);
  if (!conditional) {
    headers.delete('If-None-Match');
    headers.delete('If-Modified-Since');
  }
  const task = (async () => {
    const response = await fetcher(
      new Request(address, {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        ...(new URL(address).pathname.startsWith('/api/') || new URL(address).pathname === '/'
          ? { cache: 'no-store' }
          : {}),
      }),
    );
    const body = await boundedBody(response, controller.signal);
    const outgoing = new Headers(response.headers);
    outgoing.delete('Set-Cookie');
    // The bounded reader consumes decoded bytes; never label them with wire compression/length.
    for (const name of [
      'Content-Encoding',
      'Content-Length',
      'Transfer-Encoding',
      'Connection',
      'Keep-Alive',
    ])
      outgoing.delete(name);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: outgoing,
    });
  })();
  try {
    return await Promise.race([task, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function terminal(request, status, text) {
  const api = API_PATHS.has(new URL(request.url).pathname);
  const body = api
    ? JSON.stringify({ status: { state: 'unavailable', reason: 'origin_unreachable' }, data: null })
    : text;
  return new Response(request.method === 'HEAD' ? null : body, {
    status,
    headers: {
      'Content-Type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
      ...(status === 503 ? { 'X-Optimon-Fallback': '1' } : {}),
    },
  });
}

export async function handleRequest(request, env, fetcher = fetch) {
  let primary;
  let fallback;
  let timeout;
  try {
    primary = origin(env.DASHBOARD_PUBLIC_URL);
    fallback = origin(env.FALLBACK_ORIGIN);
    if (new URL(primary).hostname === new URL(fallback).hostname)
      throw new Error('RecursiveFallback');
    timeout = Number(env.ORIGIN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 5000)
      throw new Error('InvalidTimeout');
  } catch {
    return terminal(request, 503, 'Optimon is temporarily unavailable.');
  }
  const url = new URL(request.url);
  if (url.host !== new URL(primary).host) return terminal(request, 404, 'Not found');
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return terminal(request, 405, 'Method not allowed');
  if (url.protocol !== 'https:')
    return new Response(null, {
      status: 308,
      headers: {
        Location: new URL(url.pathname + url.search, primary).href,
        'Cache-Control': 'no-store',
      },
    });
  if (url.pathname.length > 1024 || url.search.length > 1024)
    return terminal(request, 414, 'URI too long');
  const fallbackAsset = /^\/fallback-assets\/(fallback\.css|fallback\.js)$/.test(url.pathname);
  if (
    !PUBLIC_PATHS.has(url.pathname) &&
    !/^\/assets\/[\w./-]+$/.test(url.pathname) &&
    !fallbackAsset
  )
    return terminal(request, 404, 'Not found');
  if (!fallbackAsset) {
    try {
      // Fetching this route's own request URL continues to the DNS-defined home origin.
      const response = await fetchOrigin(fetcher, request, url.href, timeout);
      // A cold-start API 503 is a healthy app waiting for its first export, not a failed tunnel.
      const waiting =
        API_PATHS.has(url.pathname) &&
        response.status === 503 &&
        response.headers.get('X-Optimon-Origin') === 'dashboard';
      if (response.status < 500 || waiting) return response;
    } catch {
      /* Bounded connection/body failures use the VPS below. */
    }
  }
  try {
    const target = new URL(url.pathname + url.search, fallback);
    // Discard validators from the home origin: its HTML ETag cannot suppress the fallback page.
    const response = await fetchOrigin(fetcher, request, target.href, FALLBACK_TIMEOUT_MS, false);
    if (
      response.headers.get('X-Optimon-Origin') !== 'fallback' ||
      (response.status >= 500 && !API_PATHS.has(url.pathname))
    )
      throw new Error('FallbackUnavailable');
    const headers = new Headers(response.headers);
    headers.set('X-Optimon-Fallback', '1');
    if (url.pathname === '/' || url.pathname === '/healthz' || API_PATHS.has(url.pathname))
      headers.set('Cache-Control', 'no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return terminal(request, 503, 'Optimon is temporarily unavailable. Please try again shortly.');
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };

// Local visual QA only. No Discord login, production database, secrets or external requests.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: { port: { type: 'string' }, host: { type: 'string' }, strictPort: { type: 'boolean' } },
});
const port = Number(process.env.PORT || values.port || '3000');
// Loopback by default; pass --host 0.0.0.0 to reach it from a VM, container or phone.
const host = values.host || '127.0.0.1';
import { join } from 'node:path';
import { createDashboard } from '../dist/dashboard-server.js';
import { loadDashboardConfig } from '../dist/dashboard-config.js';
import { DASHBOARD_WINDOWS, PUBLIC_BUCKETS } from '../dist/dashboard-data.js';
const directory = await mkdtemp(join(tmpdir(), 'optiplex-preview-'));
const now = Date.now();
const history = {
  generatedAt: now,
  firstAt: now - 6 * 86400_000,
  lastAt: now,
  totalSamples: 8236,
  windows: DASHBOARD_WINDOWS.map(({ key, minutes }) => ({
    key,
    from: now - (minutes || 8640) * 60_000,
    to: now + 1,
    count: Math.min(minutes || 8236, 8236),
    cpu: { count: 100, min: 1.2, mean: 8.6, max: 42.1 },
    memory: { count: 100, min: 9.5, mean: 12.8, max: 20.3 },
    temperature: { count: 100, min: 27.5, mean: 32.4, max: 46.2 },
    points: Array.from({ length: PUBLIC_BUCKETS }, (_, i) => ({
      at: now - (minutes || 8640) * 60_000 * (1 - (i + 0.5) / PUBLIC_BUCKETS),
      cpu:
        Math.round(
          (7 + Math.sin(i * 0.37) * 3 + (i % 29 < 3 ? 20 : 0) + (Math.sin(i * 17) + 1) * 2) * 10,
        ) / 10,
      memory: Math.round((12 + Math.sin(i * 0.08) * 1.8) * 10) / 10,
      temperature: Math.round((32 + Math.sin(i * 0.17) * 3.5) * 10) / 10,
    })),
  })),
};
await writeFile(join(directory, 'history.json'), JSON.stringify(history));
async function update() {
  const at = Date.now();
  await writeFile(
    join(directory, 'metrics.json'),
    JSON.stringify({
      schema: 1,
      version: '0.3.0',
      generatedAt: at,
      thermalWarnC: 80,
      thermalRecoverC: 75,
      live: {
        capturedAt: at,
        hostUptime: 580320,
        botUptime: 29720,
        cpuPercent: 6.8,
        cores: 6,
        memory: { total: 8136000000, used: 1070000000, available: 7066000000, percent: 13.15 },
        swap: { total: 4294967296, used: 0, available: 4294967296, percent: 0 },
        load: [0.32, 0.21, 0.18],
        temperatures: [
          { label: 'Package id 0', celsius: 32 },
          ...Array.from({ length: 6 }, (_, i) => ({
            label: `Core ${i}`,
            celsius: [29, 31, 30, 28, 29, 27][i],
          })),
        ],
      },
      history: null,
    }),
  );
}
await update();
const server = await createDashboard(
  loadDashboardConfig({ DASHBOARD_PORT: String(port), PUBLIC_DATA_PATH: directory }),
);
// A same-origin, development-only frame exercises actual mobile media queries.
// The production server keeps frame-ancestors 'none' and has no preview routes.
const [application] = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (request, response) => {
  response.setHeader('X-Optiplex-Preview', 'sample-data');
  if (request.url?.startsWith('/__preview')) {
    const width = new URL(request.url, 'http://localhost').searchParams.get('width');
    const size = ['320', '390', '768'].includes(width) ? width : '390';
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      `<!doctype html><html lang="en"><title>Optiplex responsive preview</title><body style="margin:0;background:#171719;color:#e8e9eb;font:14px system-ui"><p style="text-align:center">LOCAL SAMPLE DATA · <a style="color:#26bcc5" href="/__preview?width=320">320px</a> · <a style="color:#26bcc5" href="/__preview?width=390">390px</a> · <a style="color:#26bcc5" href="/__preview?width=768">768px</a> · <a style="color:#26bcc5" href="/">Desktop</a></p><iframe title="Mobile dashboard" src="/" width="${size}" height="900" style="display:block;margin:auto;border:1px solid #444;height:calc(100vh - 65px)"></iframe></body></html>`,
    );
    return;
  }
  const writeHead = response.writeHead.bind(response);
  response.writeHead = (status, headers) =>
    writeHead(status, {
      ...headers,
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': headers['Content-Security-Policy'].replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      ),
    });
  application(request, response);
});
server.listen(port, host, () =>
  console.log(
    `Local: http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (sample data only)`,
  ),
);
const timer = setInterval(() => {
  update().catch(console.error);
}, 30_000);
async function stop() {
  clearInterval(timer);
  server.closeAllConnections();
  server.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', () => {
  stop().catch(console.error);
});
process.once('SIGINT', () => {
  stop().catch(console.error);
});

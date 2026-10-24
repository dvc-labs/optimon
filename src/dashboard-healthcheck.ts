import { readFileSync } from 'node:fs';
import { request as https } from 'node:https';
import { request as http } from 'node:http';
import { loadDashboardConfig } from './dashboard-config.js';

try {
  const config = loadDashboardConfig();
  const request = (config.tls ? https : http)(
    {
      hostname: '127.0.0.1',
      port: config.port,
      path: '/healthz',
      timeout: 3000,
      ...(config.tls
        ? { ca: readFileSync(config.tls.ca), servername: new URL(config.publicUrl).hostname }
        : {}),
    },
    (response) => {
      response.resume();
      process.exitCode = response.statusCode === 200 ? 0 : 1;
    },
  );
  request.once('error', () => {
    process.exitCode = 1;
  });
  request.once('timeout', () => {
    request.destroy();
    process.exitCode = 1;
  });
  request.end();
} catch {
  process.exitCode = 1;
}

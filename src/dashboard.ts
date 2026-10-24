import { loadDashboardConfig } from './dashboard-config.js';
import { createDashboard } from './dashboard-server.js';

try {
  const config = loadDashboardConfig();
  const server = await createDashboard(config);
  server.on('error', () => {
    console.error('dashboard_server_failed');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () =>
    console.log(
      `Dashboard listening on ${config.tls ? 'https' : 'http'}://${config.host}:${config.port}`,
    ),
  );
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    server.close(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch {
  console.error('dashboard_initialization_failed');
  process.exitCode = 1;
}

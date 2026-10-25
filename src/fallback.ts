import { createFallback, loadFallbackConfig } from './fallback-server.js';

try {
  const config = loadFallbackConfig();
  const server = await createFallback(config);
  server.on('error', () => {
    console.error('fallback_server_failed');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => console.log('fallback_listening'));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    server.close(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  console.error('fallback_initialization_failed');
  process.exitCode = 1;
}

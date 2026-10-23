import { checkHealth } from './health.js';
process.exitCode = checkHealth() ? 0 : 1;

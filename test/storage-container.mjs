// CI runs this script through stdin inside /app in two replacement containers.
import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { History } from './dist/history.js';
import { HistoryFileStore } from './dist/storage.js';

assert.notEqual(process.getuid(), 0, 'the image must keep its non-root user');
await assert.rejects(writeFile('/app/package.json', 'must not be writable'), { code: 'EROFS' });
const store = new HistoryFileStore('/app/data/history.json');
const history = new History();
history.restore(await store.load());
if (process.env.HISTORY_SMOKE_PHASE === 'save') {
  assert.equal(history.size, 0);
  history.restore([{ at: Date.now(), cpu: 12.5, memory: 25, temperature: 31 }]);
} else {
  assert.equal(process.env.HISTORY_SMOKE_PHASE, 'restore');
  assert.equal(history.size, 1, 'a replacement container must recover the previous sample');
  assert.equal(history.summary(60).cpu.mean, 12.5);
  assert.equal(history.summary(60).temperature.mean, 31);
}
await store.save(history.exportPoints());
assert.equal(store.status().healthy, true);
assert.equal((await stat('/app/data/history.json')).mode & 0o777, 0o600);
console.log(`${process.env.HISTORY_SMOKE_PHASE}: ${history.size} persisted sample, non-root and read-only root`);

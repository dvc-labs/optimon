// CI only: run in the real runtime image with one empty, read-only host bind.
import assert from 'node:assert/strict';
import { statfs, writeFile } from 'node:fs/promises';
import { readDisk } from './dist/metrics.js';

assert.notEqual(process.getuid(), 0);
const counters = await statfs('/host-metrics/disk', { bigint: true });
const expected = JSON.parse(process.env.DISK_EXPECTED);
assert.equal(String(counters.type), expected.type);
assert.equal(String(counters.blocks * counters.bsize), expected.total);
const disk = await readDisk('/host-metrics/disk');
assert.equal(String(disk.total), expected.total);
assert.ok(disk.available >= 0 && disk.used >= 0 && disk.used <= disk.total);
assert.ok(disk.percent >= 0 && disk.percent <= 100);
await assert.rejects(writeFile('/host-metrics/disk/should-never-exist', 'no'), (error) =>
  ['EROFS', 'EACCES'].includes(error.code),
);
await assert.rejects(readDisk('/app'), /dedicated disk bind mount/);
console.log(
  'The non-root runtime reads real host filesystem capacity through an empty read-only bind.',
);

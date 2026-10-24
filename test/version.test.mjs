import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../dist/version.js';

test('the README, package, lockfile and runtime agree on the release version', async () => {
  const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const [readme, packageText, lockText] = await Promise.all([
    read('README.md'),
    read('package.json'),
    read('package-lock.json'),
  ]);
  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  assert.equal(readme.match(/\*\*Version (\d+\.\d+\.\d+)\.\*\*/)?.[1], pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(VERSION, pkg.version);
});

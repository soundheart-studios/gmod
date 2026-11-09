// The release: every place gmod states its version agrees, and the changelog
// says what this version brings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = f => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const VERSION = '1.7.1';

test('package.json, package-lock.json and plugin.json all say 1.7.1, and CHANGELOG.md has a 1.7.1 entry', () => {
  assert.equal(json('package.json').version, VERSION);
  const lock = json('package-lock.json');
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[''].version, VERSION);
  assert.equal(json('.claude-plugin/plugin.json').version, VERSION);
  const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(log, /^## 1\.7\.1\b/m, 'a 1.7.1 heading');
  const entry = log.split(/^## /m).find(s => s.startsWith('1.7.1'));
  assert.ok(entry && entry.split('\n').filter(l => /^\s*[-*] /.test(l)).length >= 1, 'the entry lists what changed');
});

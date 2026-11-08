// npm test runs every test file: a test written by a job but left out of
// package.json's list never runs in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;

// A shell word as a pattern: * matches within one path segment.
const matcher = word => new RegExp('^' + word.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '[^/]').replace(/\*/g, '[^/]*') + '$');

test("npm test's script covers every test/*.test.mjs", () => {
  const words = script.split(/\s+/).filter(w => w.startsWith('test/')).map(matcher);
  const files = readdirSync(join(root, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`);
  const missing = files.filter(f => !words.some(m => m.test(f)));
  assert.deepEqual(missing, [], `npm test leaves out: ${missing.join(', ')}`);
});

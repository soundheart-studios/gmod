import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdr, renderAdr } from '../lib/adr.mjs';

const base = { title: 'Sums never round', scope: ['src/sum.mjs'], context: 'c', decision: 'd', rules: [{ level: 'must', text: 'r' }] };
const head = text => text.split('\n---\n')[0];

test('plain titles and scopes stay unquoted', () => {
  const text = renderAdr(base, '0001', '2026-11-06');
  assert.match(text, /\ntitle: Sums never round\n/);
  assert.match(text, /\nscope: src\/sum\.mjs\n/);
});

test('a title with a colon is quoted so the frontmatter stays valid YAML, and parses back', () => {
  const d = { ...base, title: 'Scope fence: initial scope and non-goals' };
  const text = renderAdr(d, '0002', '2026-11-06');
  assert.match(head(text), /\ntitle: "Scope fence: initial scope and non-goals"\n/);
  assert.equal(parseAdr(text, '0002-x.md').title, d.title);
});

test('YAML-special leading characters and quotes are quoted and round-trip', () => {
  for (const title of ['*globs* matter', '- dashes', '# hash', 'say "hi"', "it's fine: really", 'trailing #comment', '@scope', '[brackets]', 'yes', 'null', '0042']) {
    const text = renderAdr({ ...base, title }, '0003', '2026-11-06');
    assert.equal(parseAdr(text, '0003-x.md').title, title, title);
  }
});

test('an empty scope is written as "" and parses as the whole repository', () => {
  const text = renderAdr({ ...base, scope: [] }, '0004', '2026-11-06');
  assert.match(text, /\nscope: ""\n/);
  assert.deepEqual(parseAdr(text, '0004-x.md').scope, []);
});

test('a scope starting with a glob star is quoted and parses back', () => {
  const text = renderAdr({ ...base, scope: ['**/*.go', 'api/**'] }, '0005', '2026-11-06');
  assert.match(text, /\nscope: "\*\*\/\*\.go, api\/\*\*"\n/);
  assert.deepEqual(parseAdr(text, '0005-x.md').scope, ['**/*.go', 'api/**']);
});

test('old unquoted files still parse as before', () => {
  const old = '---\nid: 0002\ntitle: Scope fence: initial\nstatus: accepted\nscope: \ndate: 2026-11-06\n---\n## Rules\n- must: x\n';
  const a = parseAdr(old, '0002-x.md');
  assert.equal(a.title, 'Scope fence: initial');
  assert.deepEqual(a.scope, []);
});

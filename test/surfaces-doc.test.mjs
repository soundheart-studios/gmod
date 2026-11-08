// The surfaces contract (docs/surfaces.md): the one page every surface (pane,
// CLI, CI, Skiff, Linear, other agents) reads to know what gmod promises. It
// must name every command and shared ref the contract promises, and the
// reference must point to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');

const COMMANDS = ['capabilities', 'state', 'signals', 'stamp', 'decide'];
const REFS = ['refs/gmod/claims', 'refs/gmod/proposal', 'refs/gmod/adr-drafts', 'refs/gmod/runs'];
const ACTIONS = ['approve', 'ask-changes', 'reject', 'accept'];

test('docs/surfaces.md names the commands capabilities, state, signals, stamp and decide, and the refs refs/gmod/proposal, refs/gmod/adr-drafts and refs/gmod/runs', () => {
  assert.ok(existsSync(join(ROOT, 'docs/surfaces.md')), 'docs/surfaces.md exists');
  const doc = read('docs/surfaces.md');
  for (const c of COMMANDS) assert.match(doc, new RegExp(`gmod ${c}\\b|\`${c}\`|${c} --json`), `names the ${c} command`);
  for (const r of REFS) assert.ok(doc.includes(r), `names ${r}`);
  for (const a of ACTIONS) assert.ok(doc.includes(`\`${a}\``), `names the ${a} action`);
  for (const s of ['Skiff', 'Linear', 'CI', 'CLI', 'pane']) assert.ok(doc.includes(s), `names the ${s} surface`);
  assert.match(doc, /protocol v1/i, 'says the protocol stays v1');
  assert.match(doc, /ADR 0001/, 'says why this is core, not managed (ADR 0001)');
});

test('docs/reference.md links to docs/surfaces.md', () => {
  assert.match(read('docs/reference.md'), /\]\(surfaces\.md\)/);
});

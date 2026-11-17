// How gmod works in Codex (docs/codex.md): install, trusting the hooks, the
// plan as text, and the person deciding in a terminal of their own. README,
// docs/agents.md and docs/limits.md point to it, and gmod capabilities says
// what the Codex hooks enforce and that board is a command a face may call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilities, describe } from '../lib/capabilities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');

test('docs/codex.md covers install, hook trust, the text plan view and deciding', () => {
  assert.ok(existsSync(join(ROOT, 'docs/codex.md')), 'docs/codex.md exists');
  const doc = read('docs/codex.md');
  // Install: the marketplace, the plugin, gmod on PATH.
  assert.match(doc, /codex plugin marketplace add/, 'adds the marketplace');
  assert.match(doc, /codex plugin add gmod@gmod/, 'adds the plugin');
  assert.match(doc, /PATH/, 'says gmod must be on PATH');
  // Hook trust.
  assert.match(doc, /\/hooks/, 'says to review and trust the hooks with /hooks');
  assert.match(doc, /trust/i);
  assert.match(doc, /upgrade/i, 'says trust is needed again after an upgrade');
  // What is the same.
  for (const t of ['mcp__gmod__commit', 'mcp__gmod__check', 'red', 'green', 'CI']) assert.ok(doc.includes(t), `names ${t}`);
  // The plan as text, and deciding.
  assert.match(doc, /gmod board/, 'names gmod board');
  assert.match(doc, /gmod watch/, 'names gmod watch');
  assert.match(doc, /gmod decide/, 'names gmod decide');
  assert.match(doc, /allow-plan/, 'says there is no allow-plan');
  assert.match(doc, /guardrail/i, 'says a hook is a guardrail');
  assert.match(doc, /gate/, "says CI's gate is the hard line");
  assert.match(doc, /< \/dev\/null/, 'says codex exec needs stdin closed');
});

test('README, docs/agents.md and docs/limits.md point to docs/codex.md', () => {
  const readme = read('README.md');
  assert.ok((readme.match(/\]\(docs\/codex\.md\)/g) ?? []).length >= 2, 'README links it from Install and from Works with what you have');
  const install = readme.split('## Install')[1]?.split('\n## ')[0] ?? '';
  assert.match(install, /\]\(docs\/codex\.md\)/, 'README Install links it');
  const works = readme.split('\n').find(l => l.includes('Works with what you have')) ?? '';
  assert.match(works, /\]\(docs\/codex\.md\)/, "README 'Works with what you have' links it");
  assert.match(read('docs/agents.md'), /\]\(codex\.md\)/, 'docs/agents.md links it');
  const limits = read('docs/limits.md');
  assert.match(limits, /\]\(codex\.md\)/, 'docs/limits.md links it');
  assert.match(limits, /Codex/);
  assert.match(limits, /trust/i, 'limits say the hooks must be trusted');
  assert.match(limits, /upgrade/i, 'and trusted again after an upgrade');
  assert.match(limits, /skipped/i, 'an untrusted hook is skipped');
});

test('gmod capabilities lists what the Codex hooks enforce and the board command', () => {
  const c = capabilities({ version: '0.0.0' });
  const codex = c.enforces.filter(e => e.kind === 'mod' && e.where.includes('lib/hook.mjs'));
  assert.ok(codex.length >= 3, 'the Codex hooks hold at least three rules');
  assert.ok(codex.some(e => /outside the claimed job/.test(e.what) && /apply_patch/.test(e.where)), 'edits outside the job');
  assert.ok(codex.some(e => /commit gate/.test(e.what)), 'the commit gate');
  assert.ok(codex.some(e => /shell/.test(e.what) || /lib\/shell\.mjs/.test(e.where)), 'the shell rules');
  for (const e of codex) assert.match(e.where, /Codex/, 'says it is Codex');
  assert.ok(c.commands.includes('board'), 'board is a command');
  assert.match(describe(c), /lib\/hook\.mjs/);
});

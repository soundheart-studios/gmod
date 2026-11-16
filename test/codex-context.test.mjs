// `gmod hook codex` tells a Codex agent what the mod tells Claude's: the
// routine, its claim (or the next job) and what waits for the person at
// SessionStart, the subagent routine at SubagentStart, and gmod's notices
// (main moved under the job, a person's answer) after a step. Real payloads
// recorded from codex-cli 0.167 live in test/fixtures/codex/ (paths as /REPO).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GMOD = join(ROOT, 'bin', 'gmod.mjs');
const FIX = join(HERE, 'fixtures', 'codex');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const k of Object.keys(ENV)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/.test(k)) delete ENV[k];
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const gmod = (cwd, ...args) => sh(cwd, 'node', [GMOD, ...args]);

const PLAN = {
  main: 'main',
  checks: { built: 'test -f notes.txt' },
  jobs: [
    { id: 'one', goal: 'Write notes', files: ['notes.txt'], tests: ['test/notes.test.mjs'], done_when: [{ text: 'notes are written', check: 'built' }] },
    { id: 'two', goal: 'Write more notes', files: ['more.txt'], done_when: [{ text: 'more notes are written', check: 'built' }] },
  ],
};

const ADR = `---
id: 0001
title: Notes are plain text
status: accepted
scope: notes.txt
date: 2026-11-08
---

## Context
Notes are read by people.

## Decision
Keep notes as plain text.

## Rules
- must: notes.txt stays plain text
- should: lines stay under 80 characters
`;

function world({ governed = true, claim = true } = {}) {
  const top = mkdtempSync(join(tmpdir(), 'gmod-codex-ctx-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const dir = join(top, 'repo');
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  if (governed) {
    mkdirSync(join(dir, '.gmod'));
    writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
    mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'adr', '0001-notes-are-plain-text.md'), ADR);
  } else writeFileSync(join(dir, 'README'), 'hi\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed']);
  sh(dir, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  if (governed && claim) gmod(dir, 'claim', 'one');
  return { top, dir, origin, done: () => rmSync(top, { recursive: true, force: true }) };
}

function event(name, dir, change = {}) {
  const e = JSON.parse(readFileSync(join(FIX, name), 'utf8').replaceAll('/REPO', dir));
  return { ...e, ...change };
}

function hook(input, cwd) {
  const r = spawnSync('node', [GMOD, 'hook', 'codex'], { cwd, env: ENV, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// The context a hook added, from its JSON answer.
function context(out, name) {
  assert.ok(out.trim(), `${name} said something`);
  const o = JSON.parse(out);
  assert.equal(o.hookSpecificOutput.hookEventName, name);
  return o.hookSpecificOutput.additionalContext;
}

test('SessionStart in a governed repository gives the routine, the claim, its files, criteria and binding ADR rules', () => {
  const w = world();
  try {
    const said = context(hook(event('session-start.json', w.dir), w.dir), 'SessionStart');
    assert.match(said, /mcp__gmod__claim/, 'the routine');
    assert.match(said, /mcp__gmod__check/);
    assert.match(said, /You hold one: Write notes/);
    assert.match(said, /notes\.txt, test\/notes\.test\.mjs/);
    assert.match(said, /- notes are written/);
    assert.match(said, /ADR 0001 \(Notes are plain text\)/);
    assert.match(said, /must: notes\.txt stays plain text/);
    assert.doesNotMatch(said, /\bpane\b|\/gmod\b/, 'no pane, no slash command');
    assert.ok(said.length < 6000, 'compact');
  } finally { w.done(); }
});

test('SessionStart without a claim names the next ready job, and says a waiting proposal is the person\'s to decide', () => {
  const w = world({ claim: false });
  try {
    let said = context(hook(event('session-start.json', w.dir), w.dir), 'SessionStart');
    assert.match(said, /No job is claimed; the next ready one is one/);
    assert.doesNotMatch(said, /waiting for the person/i);
    gmod(w.dir, 'propose-job', JSON.stringify({ id: 'three', goal: 'Write a third note', files: ['third.txt'], done_when: [{ text: 'third is written', check: 'built' }] }));
    said = context(hook(event('session-start.json', w.dir), w.dir), 'SessionStart');
    const line = said.split('\n').find(l => /waiting for the person/i.test(l));
    assert.ok(line, said);
    assert.match(line, /gmod decide/);
    assert.match(line, /gmod watch/);
    assert.match(line, /never you|not you|never by you/i);
  } finally { w.done(); }
});

test('an ungoverned repository gets no output at all', () => {
  const w = world({ governed: false });
  try {
    assert.equal(hook(event('session-start.json', w.dir), w.dir), '');
    assert.equal(hook(event('session-start.json', w.dir, { hook_event_name: 'SubagentStart' }), w.dir), '');
    assert.equal(hook(event('post-bash.json', w.dir), w.dir), '');
    assert.equal(hook(event('post-apply-patch.json', w.dir), w.dir), '');
  } finally { w.done(); }
});

test('SubagentStart gives the Codex subagent routine', async () => {
  const { CODEX_FOR_SUBAGENTS } = await import('../lib/routine.mjs');
  const w = world();
  try {
    const said = context(hook(event('session-start.json', w.dir, { hook_event_name: 'SubagentStart' }), w.dir), 'SubagentStart');
    assert.equal(said, CODEX_FOR_SUBAGENTS.trim());
    assert.match(said, /mcp__gmod__commit/);
  } finally { w.done(); }
});

test('PostToolUse passes on a person\'s answer once', () => {
  const w = world();
  try {
    assert.equal(hook(event('post-bash.json', w.dir), w.dir), '', 'nothing to tell yet');
    gmod(w.dir, 'ask', 'Round half up?');
    const s = JSON.parse(gmod(w.dir, 'signals', '--json')).signals.find(x => 'request' in x.cause);
    gmod(w.dir, 'decide', s.id, 'answer', '--note', 'yes, half up', '--via', 'skiff');
    const said = context(hook(event('post-bash.json', w.dir), w.dir), 'PostToolUse');
    assert.match(said, /answered your question about one, "Round half up\?": yes, half up/);
    assert.equal(hook(event('post-bash.json', w.dir), w.dir), '', 'once');
  } finally { w.done(); }
});

test('PostToolUse passes on main moving under the job once', () => {
  const w = world();
  try {
    const other = join(w.top, 'other');
    sh(w.top, 'git', ['clone', '-q', w.origin, other]);
    sh(other, 'git', ['config', 'user.email', 'bob@x.io']);
    sh(other, 'git', ['config', 'user.name', 'bob']);
    writeFileSync(join(other, 'notes.txt'), 'from bob\n');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-q', '-m', 'two: bob writes notes']);
    sh(other, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    sh(w.dir, 'git', ['fetch', '-q', 'origin']);
    const said = context(hook(event('post-apply-patch.json', w.dir), w.dir), 'PostToolUse');
    assert.match(said, /two landed on main and changed notes\.txt/);
    assert.match(said, /Rebase onto origin\/main/);
    assert.equal(hook(event('post-apply-patch.json', w.dir), w.dir), '', 'once');
  } finally { w.done(); }
});

test('a broken event outside PreToolUse prints nothing and fails nothing', () => {
  const w = world();
  try {
    assert.equal(hook({ hook_event_name: 'PostToolUse' }, w.dir), '');
    assert.equal(hook({ hook_event_name: 'SessionStart', cwd: join(w.top, 'missing') }, w.dir), '');
  } finally { w.done(); }
});

test('the mod and the Codex hook take the routine from the same module', async () => {
  const r = await import('../lib/routine.mjs');
  for (const k of ['ROUTINE', 'FOR_SUBAGENTS', 'CODEX_ROUTINE', 'CODEX_FOR_SUBAGENTS']) assert.equal(typeof r[k], 'string', k);
  const mod = readFileSync(join(ROOT, 'hooks', 'register.tsx'), 'utf8');
  assert.match(mod, /import \{[^}]*\bROUTINE\b[^}]*\} from '\.\.\/lib\/routine\.mjs'/);
  assert.match(mod, /import \{[^}]*\bFOR_SUBAGENTS\b[^}]*\} from '\.\.\/lib\/routine\.mjs'/);
  assert.doesNotMatch(mod, /const (ROUTINE|FOR_SUBAGENTS)\s*=/, 'no copy of its own');
  const hookSrc = readFileSync(join(ROOT, 'lib', 'hook.mjs'), 'utf8');
  assert.match(hookSrc, /from '\.\/routine\.mjs'/);
  // The Claude wording as it was; the Codex wording names no pane and no slash command.
  assert.match(r.ROUTINE, /approves them in the gmod pane or with \/gmod approve/);
  assert.match(r.FOR_SUBAGENTS, /^\n\n---\nThis repository's work is governed by gmod/);
  for (const t of [r.CODEX_ROUTINE, r.CODEX_FOR_SUBAGENTS]) assert.doesNotMatch(t, /\bpane\b|\/gmod\b/);
  assert.match(r.CODEX_ROUTINE, /gmod decide/);
  assert.match(r.CODEX_ROUTINE, /gmod watch/);
});

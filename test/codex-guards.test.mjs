// `gmod hook codex`: Codex's PreToolUse hook refuses what the Claude Code
// mod refuses. Real payloads recorded from codex-cli 0.167 live in
// test/fixtures/codex/ (paths as /REPO); each test puts a throwaway
// repository in their place and pipes the event into the hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GMOD = join(HERE, '..', 'bin', 'gmod.mjs');
const FIX = join(HERE, 'fixtures', 'codex');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const k of Object.keys(ENV)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/.test(k)) delete ENV[k];
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();

const PLAN = {
  main: 'main',
  checks: { built: 'test -f notes.txt' },
  jobs: [{ id: 'one', goal: 'Write notes', files: ['notes.txt'], done_when: [{ text: 'notes are written', check: 'built' }] }],
};

function world({ governed = true } = {}) {
  const top = mkdtempSync(join(tmpdir(), 'gmod-codex-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const dir = join(top, 'repo');
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  if (governed) {
    mkdirSync(join(dir, '.gmod'));
    writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  } else writeFileSync(join(dir, 'README'), 'hi\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed']);
  sh(dir, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  if (governed) sh(dir, 'node', [GMOD, 'claim', 'one']);
  return { dir, done: () => rmSync(top, { recursive: true, force: true }) };
}

// A recorded event with /REPO swapped for the repository, and changes.
function event(name, dir, change = {}) {
  const e = JSON.parse(readFileSync(join(FIX, name), 'utf8').replaceAll('/REPO', dir));
  return { ...e, ...change, tool_input: { ...e.tool_input, ...(change.tool_input ?? {}) } };
}

function hook(input, cwd) {
  const r = spawnSync('node', [GMOD, 'hook', 'codex'], { cwd, env: ENV, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function denied(r) {
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
  return o.hookSpecificOutput.permissionDecisionReason;
}

function allowed(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
}

const patch = (path) => ({ tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+hello\n*** End Patch` } });

test('a patch inside the claimed job passes', () => {
  const w = world();
  try {
    allowed(hook(event('pre-apply-patch.json', w.dir), w.dir));
    allowed(hook(event('pre-apply-patch.json', w.dir, { tool_input: { command: '*** Begin Patch\n*** Update File: notes.txt\n@@\n-a\n+b\n*** End Patch' } }), w.dir));
  } finally { w.done(); }
});

test('a patch outside the claimed job is denied with gmod\'s reason', () => {
  const w = world();
  try {
    const why = denied(hook(event('pre-apply-patch.json', w.dir, patch('secret.txt')), w.dir));
    assert.match(why, /^gmod: /);
    assert.match(why, /secret\.txt/);
    assert.match(denied(hook(event('pre-apply-patch-absolute.json', w.dir), w.dir)), /^gmod: .*secret\.txt/);
    // One bad path among good ones, and a move's destination, count too.
    denied(hook(event('pre-apply-patch.json', w.dir, { tool_input: { command: '*** Begin Patch\n*** Add File: notes.txt\n+x\n*** Delete File: other.txt\n*** End Patch' } }), w.dir));
    denied(hook(event('pre-apply-patch.json', w.dir, { tool_input: { command: '*** Begin Patch\n*** Update File: notes.txt\n*** Move to: moved.txt\n@@\n-a\n+b\n*** End Patch' } }), w.dir));
  } finally { w.done(); }
});

test('a patch to the plan is denied', () => {
  const w = world();
  try {
    assert.match(denied(hook(event('pre-apply-patch.json', w.dir, patch('.gmod/plan.json')), w.dir)), /^gmod: \.gmod\/plan\.json/);
    assert.match(denied(hook(event('pre-apply-patch.json', w.dir, patch(join(w.dir, '.gmod', 'plan.json'))), w.dir)), /plan\.json/);
  } finally { w.done(); }
});

test('shell commands are refused in the mod\'s words', () => {
  const w = world();
  try {
    const bash = cmd => hook(event('pre-bash.json', w.dir, { tool_input: { command: cmd } }), w.dir);
    allowed(bash('echo hi'));
    allowed(hook(event('pre-bash.json', w.dir), w.dir));
    assert.equal(denied(bash('gmod approve')), "gmod: approving or rejecting the plan is the person's decision: they do it in the gmod pane or with /gmod approve");
    assert.equal(denied(bash('gmod manage on')), "gmod: switching managed mode is the person's decision: they make it with gmod manage on|off at their own prompt");
    assert.equal(denied(bash('gh pr merge 3')), "gmod: pull requests merge through the forge once their checks pass (gmod pr --auto for a job); merging by hand is the person's call");
    assert.equal(denied(bash('git update-ref refs/gmod/claims/x HEAD')), 'gmod: claims change only through mcp__gmod__claim and mcp__gmod__release');
    assert.equal(denied(bash('echo {} > .gmod/plan.json')), 'gmod: .gmod/plan.json changes only through a proposal the person approves (mcp__gmod__propose_job), or after /gmod allow-plan');
    assert.match(denied(bash('npm test && git commit -m x')), /^gmod: a commit runs on its own/);
    assert.match(denied(bash('git commit -m x')), /^gmod: .*no failing run recorded/);
    // A commit in another directory is gated there.
    assert.match(denied(bash(`cd ${w.dir} && git commit -m x`)), /no failing run recorded/);
  } finally { w.done(); }
});

test('an ungoverned repository passes everything guardFile allows', () => {
  const w = world({ governed: false });
  try {
    allowed(hook(event('pre-apply-patch.json', w.dir, patch('secret.txt')), w.dir));
    allowed(hook(event('pre-bash.json', w.dir, { tool_input: { command: 'gh pr merge 3' } }), w.dir));
    allowed(hook(event('pre-bash.json', w.dir, { tool_input: { command: 'git commit -m x' } }), w.dir));
  } finally { w.done(); }
});

test('other events and tools pass with no output', () => {
  const w = world();
  try {
    allowed(hook(event('post-bash.json', w.dir, { tool_input: { command: 'gmod approve' } }), w.dir));
    allowed(hook(event('post-apply-patch.json', w.dir, patch('secret.txt')), w.dir));
    allowed(hook(event('session-start.json', w.dir), w.dir));
    allowed(hook(event('pre-bash.json', w.dir, { tool_name: 'WebSearch', tool_input: { command: 'gmod approve' } }), w.dir));
  } finally { w.done(); }
});

test('a hook that fails on a tool call blocks it', () => {
  const w = world();
  try {
    const r = hook('{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":', w.dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /^gmod: .+\n?$/);
    assert.equal(r.err.trim().split('\n').length, 1);
    const bad = hook({ hook_event_name: 'PreToolUse', cwd: w.dir, tool_name: 'Bash', tool_input: {} }, w.dir);
    assert.equal(bad.code, 2);
  } finally { w.done(); }
});

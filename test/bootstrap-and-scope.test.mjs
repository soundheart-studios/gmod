// Guards that don't block starting a repository or touching another one:
// the commit gate lets a repository's first commit through, and the shell
// rule about .gmod/plan.json judges the repository the path resolves to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.mjs';
import { planTargets, writesPlan } from '../lib/shell.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GMOD = join(HERE, '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const k of Object.keys(ENV)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/.test(k)) delete ENV[k];
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();

const PLAN = {
  main: 'main',
  checks: { built: 'test -f notes.txt' },
  jobs: [{ id: 'one', goal: 'Write notes', files: ['notes.txt'], done_when: [{ text: 'notes are written', check: 'built' }] }],
};

function repo(top, name, { plan = false, commit = false } = {}) {
  const dir = join(top, name);
  mkdirSync(dir);
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  writeFileSync(join(dir, 'README'), 'hi\n');
  if (plan) {
    mkdirSync(join(dir, '.gmod'));
    writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  }
  if (commit) {
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'seed']);
  }
  return dir;
}

function world() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'gmod-bootstrap-')));
  return { top, done: () => rmSync(top, { recursive: true, force: true }) };
}

function bash(cmd, cwd) {
  const r = spawnSync('node', [GMOD, 'hook', 'codex'], {
    cwd,
    env: ENV,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: cmd } }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : null;
}

const PLAN_WORDS = 'gmod: .gmod/plan.json changes only through a proposal the person approves (mcp__gmod__propose_job), or after /gmod allow-plan';

test('the commit gate lets the first commit of a new repository through', () => {
  const w = world();
  try {
    const dir = repo(w.top, 'fresh', { plan: true });
    sh(dir, 'git', ['add', '-A']);
    const r = core.gateCommit(dir);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.reason, 'the first commit: nothing is governed yet; CI judges what comes after');
    assert.equal(bash('git commit -m "start gmod"', dir), null);
    // Through the gmod command the shell hook calls, too.
    const g = spawnSync('node', [GMOD, 'gate-commit', '--shell', '--dir', dir], { cwd: dir, env: ENV, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
  } finally { w.done(); }
});

test('after the first commit an unclaimed commit is still refused', () => {
  const w = world();
  try {
    const dir = repo(w.top, 'started', { plan: true, commit: true });
    writeFileSync(join(dir, 'notes.txt'), 'x\n');
    sh(dir, 'git', ['add', '-A']);
    const r = core.gateCommit(dir);
    assert.equal(r.ok, false);
    assert.match(r.reason, /claim a job first/);
    assert.match(bash('git commit -m x', dir), /claim a job first/);
  } finally { w.done(); }
});

test('planTargets resolves the plans a command writes, and nothing it only reads', () => {
  assert.deepEqual(planTargets('echo {} > .gmod/plan.json', '/a'), ['/a/.gmod/plan.json']);
  assert.deepEqual(planTargets('cd /tmp/s && cat > .gmod/plan.json <<EOF\n{}\nEOF', '/a'), ['/tmp/s/.gmod/plan.json']);
  assert.deepEqual(planTargets('cp new.json ../b/.gmod/plan.json', '/w/a'), ['/w/b/.gmod/plan.json']);
  assert.deepEqual(planTargets('git -C ../o checkout .gmod/plan.json', '/w/a'), ['/w/o/.gmod/plan.json']);
  assert.deepEqual(planTargets("sed -i '' s/a/b/ ./.gmod/plan.json", '/a'), ['/a/.gmod/plan.json']);
  assert.deepEqual(planTargets('cd ~/x && echo {} > .gmod/plan.json', '/a', '/home/me'), ['/home/me/x/.gmod/plan.json']);
  assert.deepEqual(planTargets('echo {} > /s/.gmod/plan.json && tee .gmod/plan.json < x', '/a'), ['/s/.gmod/plan.json', '/a/.gmod/plan.json']);
  for (const read of ['cat .gmod/plan.json', 'jq . .gmod/plan.json > /tmp/x', 'cat .gmod/plan.json 2>/dev/null', 'ls']) {
    assert.deepEqual(planTargets(read, '/a'), [], read);
  }
  // Kept for whoever still asks the old question.
  assert.equal(writesPlan('echo {} > .gmod/plan.json'), true);
  assert.equal(writesPlan('cat .gmod/plan.json'), false);
});

test('writing the plan is refused in a governed repository, wherever the session is', () => {
  const w = world();
  try {
    const gov = repo(w.top, 'gov', { plan: true, commit: true });
    const other = repo(w.top, 'other', { commit: true });
    assert.equal(bash('echo {} > .gmod/plan.json', gov), PLAN_WORDS);
    assert.equal(bash(`cd ${gov} && echo {} > .gmod/plan.json`, other), PLAN_WORDS);
    assert.equal(bash(`echo {} > ${gov}/.gmod/plan.json`, other), PLAN_WORDS);
    // The gmod command the Claude Code hook asks says the same.
    const g = spawnSync('node', [GMOD, 'guard-path', join(gov, '.gmod', 'plan.json')], { cwd: other, env: ENV, encoding: 'utf8' });
    assert.equal(g.status, 1);
    assert.match(g.stdout + g.stderr, /allow-plan/);
  } finally { w.done(); }
});

test('writing a plan is allowed in a repository with no committed plan, judged by where the path resolves', () => {
  const w = world();
  try {
    const gov = repo(w.top, 'gov', { plan: true, commit: true });
    const scratch = repo(w.top, 'scratch', { commit: true });
    const fresh = repo(w.top, 'fresh');
    // From a governed session, into another repository.
    assert.equal(bash(`cd ${scratch} && mkdir -p .gmod && echo {} > .gmod/plan.json`, gov), null);
    assert.equal(bash(`echo {} > ${fresh}/.gmod/plan.json`, gov), null);
    // A brand-new repository's own plan, from inside it.
    assert.equal(bash('echo {} > .gmod/plan.json', fresh), null);
    // A plan on disk that was never committed governs nothing yet.
    mkdirSync(join(scratch, '.gmod'), { recursive: true });
    writeFileSync(join(scratch, '.gmod', 'plan.json'), JSON.stringify(PLAN));
    assert.equal(bash("sed -i '' s/a/b/ .gmod/plan.json", scratch), null);
    const g = spawnSync('node', [GMOD, 'guard-path', join(scratch, '.gmod', 'plan.json')], { cwd: gov, env: ENV, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stdout + g.stderr);
  } finally { w.done(); }
});

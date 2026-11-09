// A released job's branch doesn't block the next claim. Seen in Skiff: an
// agent claimed a job in its worktree, released it and stopped, leaving
// gmod/<job> checked out there; the next agent's claim couldn't switch to the
// branch, and its pull request went up from the wrong one. Now release, on a
// clean worktree, steps off the job's branch (and deletes it when it holds no
// work), and claim names the worktree that still holds the branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const gmod = (cwd, ...args) => {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const ok = (cwd, ...args) => {
  const r = gmod(cwd, ...args);
  assert.equal(r.code, 0, `gmod ${args.join(' ')}: ${r.err}`);
  return r.out;
};

const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'add-sum', goal: 'Sum', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sums', check: 'ok' }] }] };

function world() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'gmod-release-branch-')));
  const origin = join(top, 'origin.git');
  sh(top, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = join(top, 'main');
  sh(top, 'clone', '-q', origin, dir);
  sh(dir, 'config', 'user.email', 'alice@x.io');
  sh(dir, 'config', 'user.name', 'alice');
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'seed the plan');
  sh(dir, 'push', '-q', 'origin', 'HEAD:main');
  const wt = name => {
    const p = join(top, name);
    sh(dir, 'worktree', 'add', '-q', '--detach', p, 'origin/main');
    return p;
  };
  return { dir, wt, done: () => rmSync(top, { recursive: true, force: true }) };
}

const branchOf = dir => sh(dir, 'branch', '--show-current');
const hasBranch = (dir, name) => sh(dir, 'branch', '--list', name) !== '';
function startWork(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
}

test('release on a clean worktree steps off the job branch, and deletes it when it holds no work', () => {
  const w = world();
  try {
    const a = w.wt('agent-a');
    ok(a, 'claim', 'add-sum');
    assert.equal(branchOf(a), 'gmod/add-sum');
    ok(a, 'release');
    assert.notEqual(branchOf(a), 'gmod/add-sum', 'no longer on the job branch');
    assert.equal(hasBranch(a, 'gmod/add-sum'), false, 'an empty branch is deleted');
    // The next claim, in another worktree, gets the branch.
    const b = w.wt('agent-b');
    ok(b, 'claim', 'add-sum');
    assert.equal(branchOf(b), 'gmod/add-sum');
  } finally { w.done(); }
});

test('a branch with commits, or a worktree with uncommitted work, is left as it is', () => {
  const w = world();
  try {
    const a = w.wt('agent-a');
    ok(a, 'claim', 'add-sum');
    startWork(a);
    sh(a, 'add', '-A');
    sh(a, 'commit', '-q', '-m', 'add-sum: start');
    ok(a, 'release');
    assert.equal(branchOf(a), 'gmod/add-sum', 'work on the branch: stays checked out');

    const b = w.wt('agent-b');
    // A fresh worktree: claim, leave work uncommitted, release.
    sh(a, 'switch', '-q', '--detach');
    sh(a, 'branch', '-q', '-D', 'gmod/add-sum');
    ok(b, 'claim', 'add-sum');
    startWork(b);
    ok(b, 'release');
    assert.equal(branchOf(b), 'gmod/add-sum', 'uncommitted work: stays on the branch');
    assert.equal(hasBranch(b, 'gmod/add-sum'), true);
  } finally { w.done(); }
});

test('claiming a job whose branch is checked out in another worktree names it and how to free it', () => {
  const w = world();
  try {
    const a = w.wt('agent-a');
    ok(a, 'claim', 'add-sum');
    startWork(a);
    sh(a, 'add', '-A');
    sh(a, 'commit', '-q', '-m', 'add-sum: start');
    ok(a, 'release');

    const b = w.wt('agent-b');
    const r = gmod(b, 'claim', 'add-sum');
    assert.notEqual(r.code, 0, 'refused rather than carrying on from the wrong branch');
    assert.ok(r.err.includes(a), `names the worktree: ${r.err}`);
    assert.match(r.err, /git worktree remove/);
    assert.notEqual(branchOf(b), 'gmod/add-sum');
    assert.equal(sh(b, 'for-each-ref', 'refs/gmod/claims/'), '', 'the refused claim is not taken');
  } finally { w.done(); }
});

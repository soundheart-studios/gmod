// A plan proposal that changes nothing: never started by describing, never
// approvable, and refused in plain words rather than by git. (Landing the 1.7
// plan left one behind: describe_proposal after an approve started an empty
// draft, and approving it failed with "git commit -q -m plan: no change".)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function gmod(cwd, ...args) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const JOB = { id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }] };
const PLAN = { main: 'main', checks: { sum: 'node test/sum.test.mjs' }, jobs: [JOB] };

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-empty-proposal-'));
  const dir = join(top, 'work');
  mkdirSync(join(dir, '.gmod'), { recursive: true });
  sh(top, 'git', ['init', '-q', '-b', 'main', dir]);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed the plan']);
  return { dir, done: () => rmSync(top, { recursive: true, force: true }) };
}

// A proposal whose plan is the plan as it stands: the job proposed again, unchanged.
function emptyProposal(dir) {
  const r = gmod(dir, 'propose-job', JSON.stringify(JOB));
  assert.equal(r.code, 0, r.err);
  assert.equal(gmod(dir, 'proposal', '--json').code, 0);
}

test('describing with no proposal pending is refused and creates no proposal', () => {
  const w = world();
  try {
    const r = gmod(w.dir, 'describe-proposal', '--summary', 'nothing to describe');
    assert.notEqual(r.code, 0, 'refused');
    assert.match(r.err + r.out, /no proposal to describe/);
    assert.equal(JSON.parse(gmod(w.dir, 'signals', '--json').out).signals.length, 0, 'no proposal left behind');
  } finally { w.done(); }
});

test('approving a proposal that changes nothing is refused in plain words and commits nothing', () => {
  const w = world();
  try {
    emptyProposal(w.dir);
    const head = sh(w.dir, 'git', ['rev-parse', 'HEAD']);
    const r = gmod(w.dir, 'approve');
    assert.notEqual(r.code, 0, 'refused');
    assert.match(r.err + r.out, /changes nothing: reject it/);
    assert.doesNotMatch(r.err + r.out, /git commit/, 'not a raw git error');
    assert.equal(sh(w.dir, 'git', ['rev-parse', 'HEAD']), head, 'nothing committed');
  } finally { w.done(); }
});

test('an empty proposal is not ready, so its signal offers no approve', () => {
  const w = world();
  try {
    emptyProposal(w.dir);
    const [s] = JSON.parse(gmod(w.dir, 'signals', '--json').out).signals;
    assert.ok(s, 'the proposal still shows, to be rejected');
    assert.ok(!s.actions.includes('approve'), `actions: ${s.actions}`);
    assert.ok(s.actions.includes('reject'));
    assert.match(s.detail ?? '', /changes nothing/);
  } finally { w.done(); }
});

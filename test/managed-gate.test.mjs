// The gate lands a managed switch like a plan change: a person's decision,
// .gmod/managed.json alone. Mixed with anything else, it is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { verify } from '../lib/core.mjs';

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function write(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

const PLAN = {
  main: 'main',
  checks: { sum: 'node test/sum.test.mjs' },
  jobs: [{ id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }] }],
};
const ON = JSON.stringify({ v: 1, managed: true }, null, 2) + '\n';

// A repository with a plan on main, and a branch that commits `files`.
function pr(branch, files) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-managed-gate-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  write(dir, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n' });
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(dir, 'git', ['checkout', '-q', '-b', branch]);
  write(dir, files);
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'managed: on']);
  const r = verify(dir, { base: 'main', head: 'HEAD', branch });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test('a pull request changing only .gmod/managed.json passes the gate as a decision', () => {
  const r = pr('gmod/managed-on-abc1234', { '.gmod/managed.json': ON });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.mode, 'managed');
  assert.ok(r.findings.some(f => /review/.test(f.msg)), 'it gets the governance review');
});

test('turning it off passes too', () => {
  const r = pr('gmod/managed-off-abc1234', { '.gmod/managed.json': JSON.stringify({ v: 1, managed: false }) });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.mode, 'managed');
});

test('a managed switch mixed with code is refused', () => {
  const r = pr('gmod/managed-on-abc1234', { '.gmod/managed.json': ON, 'src/sum.mjs': 'export const sum = (a, b) => a + b;\n' });
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'managed');
  assert.ok(r.findings.some(f => !f.ok && /src\/sum\.mjs/.test(f.msg)));
});

test('a managed switch mixed with a plan change is refused', () => {
  const plan = { ...PLAN, jobs: [...PLAN.jobs, { id: 'add-neg', goal: 'Negate', files: ['src/neg.mjs'], done_when: [{ text: 'neg', check: 'sum' }] }] };
  const r = pr('gmod/managed-on-abc1234', { '.gmod/managed.json': ON, '.gmod/plan.json': JSON.stringify(plan, null, 2) });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => !f.ok && /\.gmod\/plan\.json/.test(f.msg)));
});

test('a managed switch mixed with another .gmod file is refused', () => {
  const r = pr('gmod/managed-on-abc1234', { '.gmod/managed.json': ON, '.gmod/notes.txt': 'x\n' });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => !f.ok && /\.gmod\/notes\.txt/.test(f.msg)));
});

test('a managed switch that is not a valid switch is refused', () => {
  const r = pr('gmod/managed-on-abc1234', { '.gmod/managed.json': '{ "managed": "yes" }' });
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'managed');
});

test('a job pull request is judged as before', () => {
  const r = pr('gmod/add-sum', { 'src/sum.mjs': 'export const sum = (a, b) => a + b;\n' });
  assert.equal(r.mode, 'job');
});

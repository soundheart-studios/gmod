// Reading gmod stays fast with many worktrees: leftover worktrees of jobs that
// already landed must not each cost a walk of main's history, and what state
// and signals print must not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const LANDED = Array.from({ length: 10 }, (_, i) => `job${i + 1}`);

const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function gmod(cwd, args, env = ENV) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function write(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}
function clone(origin, dir, email) {
  sh(dirname(dir), 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', email]);
  sh(dir, 'git', ['config', 'user.name', email.split('@')[0]]);
}

const PLAN = {
  main: 'main',
  checks: { ok: 'true', bad: 'false' },
  jobs: [
    ...LANDED.map(id => ({ id, goal: `Part ${id}`, files: [`src/${id}.mjs`], done_when: [{ text: `${id} works`, check: 'ok' }] })),
    { id: 'live', goal: 'Work in progress', files: ['src/live.mjs'], done_when: [{ text: 'live works', check: 'ok' }] },
    { id: 'stuck', goal: 'Work that fails', files: ['src/stuck.mjs'], done_when: [{ text: 'stuck works', check: 'bad' }] },
  ],
};

// A repository where each landed job left its worktree behind (as agents'
// worktrees do), plus, when asked, a claimed job and a stuck one.
function world({ active = false } = {}) {
  const top = mkdtempSync(join(tmpdir(), 'gmod-fast-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(top, 'seed');
  clone(origin, seed, 'owner@x.io');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), README: 'x\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);

  const repo = join(top, 'repo');
  clone(origin, repo, 'dev@x.io');
  const claimIn = id => {
    const wt = join(top, `wt-${id}`);
    sh(repo, 'git', ['worktree', 'add', '-q', '--detach', wt, 'origin/main']);
    const r = gmod(wt, ['claim', id]);
    assert.equal(r.code, 0, r.err);
    return wt;
  };
  for (const id of LANDED) {
    claimIn(id);
    write(seed, { [`src/${id}.mjs`]: `export const x = 1;\n` });
    sh(seed, 'git', ['add', '-A']);
    sh(seed, 'git', ['commit', '-q', '-m', `${id}: part ${id}`]);
    sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  }
  if (active) {
    claimIn('live');
    const stuck = claimIn('stuck');
    gmod(stuck, ['check']);
  }
  sh(repo, 'git', ['fetch', '-q', 'origin']);
  return { top, repo, done: () => rmSync(top, { recursive: true, force: true }) };
}

// Runs gmod with a git on PATH that counts its calls.
function counted(top, cwd, args) {
  const bin = join(top, 'bin');
  const log = join(top, 'git-calls.log');
  const real = sh(top, 'sh', ['-c', 'command -v git']);
  write(bin, { git: `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n` });
  chmodSync(join(bin, 'git'), 0o755);
  writeFileSync(log, '');
  const r = gmod(cwd, args, { ...ENV, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.code, 0, r.err);
  return { out: r.out, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('with 10 worktrees of landed jobs, gmod state --json --no-sync runs at most 25 git commands', () => {
  const w = world();
  try {
    const { out, calls } = counted(w.top, w.repo, ['state', '--json', '--no-sync']);
    const s = JSON.parse(out);
    assert.deepEqual(s.jobs.filter(j => j.state === 'proven').map(j => j.id), LANDED);
    assert.ok(calls.length <= 25, `${calls.length} git commands:\n${calls.join('\n')}`);
  } finally {
    w.done();
  }
});

test('state and signals print the same as before for a repository with landed, claimed and stuck worktrees', () => {
  const w = world({ active: true });
  try {
    const s = JSON.parse(counted(w.top, w.repo, ['state', '--json', '--no-sync']).out);
    const by = Object.fromEntries(s.jobs.map(j => [j.id, j]));
    for (const id of LANDED) {
      // A landed job still says where its leftover worktree is, and its proof.
      assert.equal(by[id].state, 'proven', id);
      assert.equal(by[id].where, `wt-${id}`, id);
      assert.equal(by[id].stage, 6, id);
      assert.ok(by[id].since, id);
    }
    assert.equal(by.live.state, 'working');
    assert.equal(by.live.where, 'wt-live');
    assert.equal(by.stuck.state, 'stuck');
    assert.equal(by.stuck.tests, 'red');

    const sig = JSON.parse(counted(w.top, w.repo, ['signals', '--json', '--no-sync']).out);
    assert.deepEqual(sig.signals.map(x => [x.kind, x.cause]), [['unstick', { stuck: 'stuck' }]]);

    const status = JSON.parse(counted(w.top, w.repo, ['status', '--json', '--no-sync']).out);
    const st = Object.fromEntries(status.jobs.map(j => [j.id, j]));
    for (const id of LANDED) assert.deepEqual(st[id].criteria, [{ text: `${id} works`, pass: null }], id);
    // A live job is still checked against main; a landed one never is.
    assert.ok(st.live.moved, 'live job has its moved check');
    for (const id of LANDED) assert.equal(st[id].moved, null, id);
  } finally {
    w.done();
  }
});

// gmod state --json: the plan and its progress, as a face like Skiff reads it.
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
  checks: { ok: 'true' },
  phases: [
    { id: 'build', title: 'Build it', outcome: 'It is built' },
    { id: 'ship', title: 'Ship it', outcome: 'It is shipped', after: ['build'] },
  ],
  jobs: [
    { id: 'one', goal: 'The first part', files: ['src/one.mjs'], tests: ['test/one.test.mjs'], done_when: [{ text: 'one works', check: 'ok' }], phase: 'build' },
    { id: 'two', goal: 'The second part', files: ['src/two.mjs'], done_when: [{ text: 'two works', check: 'ok' }], phase: 'build' },
    { id: 'three', goal: 'The third part', files: ['src/three.mjs'], done_when: [{ text: 'three works', check: 'ok' }], phase: 'build' },
    { id: 'four', goal: 'Ship the parts', files: ['src/ship.mjs'], done_when: [{ text: 'shipped', check: 'ok' }], phase: 'ship' },
  ],
};

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-state-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(top, 'seed');
  clone(origin, seed, 'owner@x.io');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), README: 'x\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { top, origin, seed, done: () => rmSync(top, { recursive: true, force: true }) };
}

function land(seed, id) {
  write(seed, { [`src/${id}.mjs`]: `export const ${id} = 1;\n` });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', `${id}: the ${id} part`]);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
}

const stateOf = dir => {
  const r = gmod(dir, 'state', '--json');
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

test('state --json on a test repo lists phases, jobs and their states', () => {
  const w = world();
  try {
    const alice = join(w.top, 'alice');
    clone(w.origin, alice, 'alice@x.io');
    assert.equal(gmod(alice, 'claim', 'two').code, 0);
    const s = stateOf(alice);

    assert.equal(s.v, 1);
    assert.equal(s.project, 'alice');
    assert.deepEqual(s.plan.phases.map(p => [p.id, p.title, p.outcome]), [['build', 'Build it', 'It is built'], ['ship', 'Ship it', 'It is shipped']]);
    assert.deepEqual(s.plan.phases.map(p => [p.state, p.done, p.total]), [['active', 0, 3], ['waiting', 0, 1]]);
    assert.ok(Array.isArray(s.plan.backlog));
    assert.ok(Array.isArray(s.activity));

    const by = Object.fromEntries(s.jobs.map(j => [j.id, j]));
    assert.deepEqual(s.jobs.map(j => j.id), ['one', 'two', 'three', 'four']);
    assert.equal(by.one.state, 'ready');
    assert.equal(by.two.state, 'working');
    assert.equal(by.two.by, 'alice@x.io');
    assert.equal(by.three.state, 'ready');
    assert.equal(by.four.state, 'waiting');
    assert.match(by.four.note, /after/);
    assert.equal(by.one.goal, 'The first part');
    assert.equal(by.one.phase, 'build');
    assert.deepEqual(by.one.files, ['src/one.mjs', 'test/one.test.mjs']);
    assert.deepEqual(by.one.done_when, ['one works']);

    // Read-only: nothing on disk or in git changes.
    assert.equal(sh(alice, 'git', ['status', '--porcelain']), '');
    // The words a person reads, too.
    const text = gmod(alice, 'state');
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, /Build it/);
  } finally { w.done(); }
});

test('a job with a landed <job>: commit shows as proven', () => {
  const w = world();
  try {
    land(w.seed, 'one');
    const bob = join(w.top, 'bob');
    clone(w.origin, bob, 'bob@x.io');
    const s = stateOf(bob);
    const one = s.jobs.find(j => j.id === 'one');
    assert.equal(one.state, 'proven');
    assert.ok(!Number.isNaN(Date.parse(one.since)), `since is a date: ${one.since}`);
    assert.equal(s.jobs.find(j => j.id === 'two').state, 'ready');
    assert.deepEqual(s.plan.phases.map(p => [p.id, p.done, p.total]), [['build', 1, 3], ['ship', 0, 1]]);
    assert.equal(s.activity[0].kind, 'landed');
    assert.match(s.activity[0].title, /^one landed/);
    assert.ok(s.activity[0].id);

    // Once every job in a phase lands, the next phase's jobs are ready.
    land(w.seed, 'two');
    land(w.seed, 'three');
    sh(bob, 'git', ['pull', '-q', 'origin', 'main']);
    const after = stateOf(bob);
    assert.deepEqual(after.jobs.map(j => j.state), ['proven', 'proven', 'proven', 'ready']);
    assert.deepEqual(after.activity.slice(0, 3).map(a => a.title.split(' ')[0]), ['three', 'two', 'one']);
  } finally { w.done(); }
});

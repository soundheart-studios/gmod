// The plan proposal is shared (ADR 0002): it lives at refs/gmod/proposal,
// pushed to origin like claims, so every clone, machine and surface sees the
// same draft. Writes are compare-and-swap: a lost race reads again and
// re-applies the edit, never overwriting. Approving or rejecting removes it
// everywhere. A 1.6 proposal.json is carried over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function gmod(cwd, ...args) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const ok = (cwd, ...args) => {
  const r = gmod(cwd, ...args);
  assert.equal(r.code, 0, `gmod ${args.join(' ')}: ${r.err}`);
  return r.out;
};
function gmodAsync(cwd, ...args) {
  return new Promise(done => {
    const p = spawn('node', [GMOD, ...args], { cwd, env: ENV });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => done({ code, err }));
  });
}

const job = (id, files = [`src/${id}.mjs`]) => ({ id, goal: `Do ${id}`, files, tests: [`test/${id}.test.mjs`], done_when: [{ text: `${id} works`, check: 'ok' }] });
const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [job('add-sum')] };

function clone(top, origin, name) {
  const dir = join(top, name);
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', `${name}@x.io`]);
  sh(dir, 'git', ['config', 'user.name', name]);
  return dir;
}

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-shared-proposal-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const alice = clone(top, origin, 'alice');
  mkdirSync(join(alice, '.gmod'));
  writeFileSync(join(alice, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  sh(alice, 'git', ['add', '-A']);
  sh(alice, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  const bob = clone(top, origin, 'bob');
  return { top, origin, alice, bob, done: () => rmSync(top, { recursive: true, force: true }) };
}

// What this clone's proposal adds, after a read that syncs (signals).
function added(dir) {
  ok(dir, 'signals', '--json');
  const p = JSON.parse(ok(dir, 'proposal', '--json'));
  return p ? p.diff.added.map(j => j.id).sort() : null;
}
const onOrigin = w => spawnSync('git', ['--git-dir', w.origin, 'rev-parse', '-q', '--verify', 'refs/gmod/proposal'], { env: ENV }).status === 0;

test('a job drafted in one clone shows in another clone\'s proposal after a read', () => {
  const w = world();
  try {
    ok(w.alice, 'propose-job', JSON.stringify(job('add-neg')));
    assert.ok(onOrigin(w), 'the proposal is pushed to refs/gmod/proposal');
    assert.deepEqual(added(w.bob), ['add-neg']);
    // And back: bob's edit reaches alice.
    ok(w.bob, 'propose-job', JSON.stringify(job('add-mul')));
    assert.deepEqual(added(w.alice), ['add-mul', 'add-neg']);
  } finally { w.done(); }
});

test('two clones drafting at once both keep their edits; neither overwrites the other', async () => {
  const w = world();
  try {
    ok(w.alice, 'propose-job', JSON.stringify(job('seed-job')));
    added(w.bob);
    const side = (dir, name) => (async () => {
      for (let i = 0; i < 4; i++) {
        const r = await gmodAsync(dir, 'propose-job', JSON.stringify(job(`${name}-${i}`)));
        assert.equal(r.code, 0, r.err);
      }
    })();
    await Promise.all([side(w.alice, 'a'), side(w.bob, 'b')]);
    const want = ['seed-job', ...[0, 1, 2, 3].flatMap(i => [`a-${i}`, `b-${i}`])].sort();
    assert.deepEqual(added(w.alice), want);
    assert.deepEqual(added(w.bob), want);
  } finally { w.done(); }
});

test('approving or rejecting in one clone removes the proposal everywhere', () => {
  const w = world();
  try {
    ok(w.alice, 'propose-job', JSON.stringify(job('add-neg')));
    assert.deepEqual(added(w.bob), ['add-neg']);
    ok(w.alice, 'approve', '--no-pr');
    assert.ok(!onOrigin(w), 'gone from origin');
    assert.equal(added(w.bob), null, 'gone from the other clone');

    ok(w.bob, 'propose-job', JSON.stringify(job('add-mul')));
    assert.deepEqual(added(w.alice), ['add-mul']);
    ok(w.bob, 'reject', 'not now');
    assert.ok(!onOrigin(w));
    assert.equal(added(w.alice), null);
  } finally { w.done(); }
});

test('a 1.6 proposal.json is carried over to the ref', () => {
  const w = world();
  try {
    const plan = { ...PLAN, jobs: [...PLAN.jobs, job('add-old')] };
    const base = sh(w.alice, 'git', ['hash-object', '.gmod/plan.json']);
    const legacy = join(w.alice, '.git', 'gmod', 'proposal.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ by: 'alice@x.io', at: '2026-11-01T00:00:00.000Z', base, plan, summary: 'from 1.6' }, null, 2));
    assert.deepEqual(added(w.alice), ['add-old']);
    assert.ok(!existsSync(legacy), 'the old file is gone once carried over');
    assert.ok(onOrigin(w), 'and pushed');
    assert.deepEqual(added(w.bob), ['add-old']);
    assert.equal(JSON.parse(ok(w.bob, 'proposal', '--json')).headline, 'from 1.6');
  } finally { w.done(); }
});

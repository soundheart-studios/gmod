// A proposal whose plan has landed is gone, wherever a copy of it lingers.
// Seen in Skiff on 1.7.1: after a pane approve, refs/gmod/proposal came back,
// here and on origin, pointing at the very draft just approved, and the pane
// showed it as "no changes". A stale local copy, with no tracking copy, was
// taken by the next sync for an edit made offline and pushed. A proposal
// whose plan is the plan on disk, drafted against an older one, has landed:
// sync drops it everywhere, and readers never show it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const gmod = (cwd, ...args) => {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `gmod ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const REF = 'refs/gmod/proposal';
const TRACK = 'refs/gmod-origin/proposal';
const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'add-sum', goal: 'Sum', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sums', check: 'ok' }] }] };
const job = id => JSON.stringify({ id, goal: id, files: [`src/${id}/**`], tests: [`test/${id}/**`], done_when: [{ text: id, check: 'ok' }] });

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-landed-'));
  const origin = join(top, 'origin.git');
  git(top, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = join(top, 'alice');
  git(top, 'clone', '-q', origin, dir);
  git(dir, 'config', 'user.email', 'alice@x.io');
  git(dir, 'config', 'user.name', 'alice');
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed the plan');
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
  return { dir, done: () => rmSync(top, { recursive: true, force: true }) };
}

const tipOf = (dir, ref) => spawnSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: dir, env: ENV, encoding: 'utf8' }).stdout.trim();
const atOrigin = dir => git(dir, 'ls-remote', 'origin', REF);

// Approve a fresh draft, land it on main, and return the approved draft's commit.
function approved(dir, id) {
  gmod(dir, 'propose-job', job(id));
  const p = tipOf(dir, REF);
  assert.ok(p, 'drafted');
  gmod(dir, 'approve', '--no-pr');
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(tipOf(dir, REF), '', 'approve takes it down');
  return p;
}

test('a stale local copy of an approved draft is dropped by the next sync, not pushed back', () => {
  const w = world();
  try {
    const p = approved(w.dir, 'add-neg');
    git(w.dir, 'update-ref', REF, p); // left behind by some other process
    gmod(w.dir, 'state', '--json');
    assert.equal(tipOf(w.dir, REF), '', 'gone here');
    assert.equal(atOrigin(w.dir), '', 'never pushed to origin');
    gmod(w.dir, 'state', '--json');
    assert.equal(tipOf(w.dir, REF), '');
    assert.equal(atOrigin(w.dir), '');
  } finally { w.done(); }
});

test('a landed draft already back on origin is taken down there too', () => {
  const w = world();
  try {
    const p = approved(w.dir, 'add-neg');
    git(w.dir, 'push', '-q', 'origin', `${p}:${REF}`);
    git(w.dir, 'update-ref', REF, p);
    git(w.dir, 'update-ref', TRACK, p);
    gmod(w.dir, 'state', '--json');
    assert.equal(tipOf(w.dir, REF), '');
    assert.equal(atOrigin(w.dir), '', 'taken down on origin');
  } finally { w.done(); }
});

test('a landed proposal is never shown; a draft against the current plan still is', () => {
  const w = world();
  try {
    const p = approved(w.dir, 'add-neg');
    git(w.dir, 'update-ref', REF, p);
    // Read without syncing: still not shown, and nothing offered to decide.
    assert.equal(JSON.parse(gmod(w.dir, 'proposal', '--json', '--no-sync')), null);
    const signals = JSON.parse(gmod(w.dir, 'signals', '--json', '--no-sync')).signals;
    assert.equal(signals.find(s => 'proposal' in s.cause), undefined);

    // A new draft against the plan as it stands is a real proposal.
    git(w.dir, 'update-ref', '-d', REF);
    gmod(w.dir, 'propose-job', job('add-mul'));
    gmod(w.dir, 'state', '--json');
    assert.ok(tipOf(w.dir, REF), 'kept');
    assert.ok(atOrigin(w.dir), 'and shared');
    const s = JSON.parse(gmod(w.dir, 'signals', '--json', '--no-sync')).signals;
    assert.ok(s.find(x => 'proposal' in x.cause), 'offered to decide');
  } finally { w.done(); }
});

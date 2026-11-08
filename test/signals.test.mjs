// gmod signals --json: what needs a person, as a face like Skiff reads it.
// The pane's "Needs you" is drawn from the same list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paneLine, signalsFrom } from '../lib/signals.mjs';

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
  checks: { done: 'test -f done.txt', ok: 'true' },
  jobs: [
    { id: 'one', goal: 'The first part', files: ['src/one.mjs', 'done.txt'], done_when: [{ text: 'one works', check: 'done' }] },
    { id: 'two', goal: 'The second part', files: ['src/two.mjs'], done_when: [{ text: 'two works', check: 'ok' }] },
  ],
};

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-signals-'));
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

const signalsOf = dir => {
  const r = gmod(dir, 'signals', '--json', '--no-sync');
  assert.equal(r.code, 0, r.err);
  const s = JSON.parse(r.out);
  assert.equal(s.v, 1);
  assert.ok(Array.isArray(s.workers));
  return s.signals;
};
const byCause = (list, key) => list.find(s => key in s.cause);

test('a pending proposal and a stuck job each give a signal with a stable id', () => {
  const w = world();
  try {
    const alice = join(w.top, 'alice');
    clone(w.origin, alice, 'alice@x.io');
    assert.deepEqual(signalsOf(alice), [], 'nothing needs a person yet');

    assert.equal(gmod(alice, 'claim', 'one').code, 0);
    assert.equal(gmod(alice, 'check').code, 1, 'red: done.txt is missing');
    assert.equal(gmod(alice, 'propose-job', JSON.stringify({ id: 'three', goal: 'A third part', files: ['src/three.mjs'], done_when: [{ text: 'three works', check: 'ok' }] })).code, 0);

    const first = signalsOf(alice);
    const stuck = byCause(first, 'stuck');
    const prop = byCause(first, 'proposal');
    assert.ok(stuck, JSON.stringify(first));
    assert.ok(prop, JSON.stringify(first));

    assert.equal(stuck.v, 1);
    assert.equal(stuck.kind, 'unstick');
    assert.equal(stuck.cause.stuck, 'one');
    assert.equal(stuck.project, 'alice');
    assert.match(stuck.question, /^one is red: its criteria still fail$/);
    assert.ok(Array.isArray(stuck.evidence) && Array.isArray(stuck.actions) && stuck.actions.length);

    assert.equal(prop.kind, 'decide');
    assert.ok(Array.isArray(prop.evidence) && prop.actions.includes('reject'));
    assert.ok(prop.question.length > 0);
    for (const s of first) {
      assert.match(s.id, /^[0-9a-f]{6,}$/);
      assert.ok(['decide', 'unstick', 'know'].includes(s.kind));
    }
    assert.equal(new Set(first.map(s => s.id)).size, first.length, 'ids are distinct');

    // The same causes, asked again: the same ids.
    const again = signalsOf(alice);
    assert.deepEqual(again.map(s => s.id), first.map(s => s.id));

    // Read-only: signals write nothing.
    const before = sh(alice, 'git', ['status', '--porcelain']);
    signalsOf(alice);
    assert.equal(sh(alice, 'git', ['status', '--porcelain']), before);

    // The words a person reads, too.
    const text = gmod(alice, 'signals', '--no-sync');
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, /one is red/);
  } finally { w.done(); }
});

test('a resolved cause no longer gives its signal', () => {
  const w = world();
  try {
    const bob = join(w.top, 'bob');
    clone(w.origin, bob, 'bob@x.io');
    assert.equal(gmod(bob, 'claim', 'one').code, 0);
    assert.equal(gmod(bob, 'check').code, 1);
    assert.equal(gmod(bob, 'propose-job', JSON.stringify({ id: 'three', goal: 'A third part', files: ['src/three.mjs'], done_when: [{ text: 'three works', check: 'ok' }] })).code, 0);
    const first = signalsOf(bob);
    const stuckId = byCause(first, 'stuck').id;
    const propId = byCause(first, 'proposal').id;

    // The job goes green: it is stuck no longer.
    write(bob, { 'done.txt': 'yes\n' });
    assert.equal(gmod(bob, 'check').code, 0);
    const after = signalsOf(bob);
    assert.equal(byCause(after, 'stuck'), undefined, JSON.stringify(after));
    assert.equal(after.find(s => s.id === propId)?.id, propId, 'the proposal is still waiting, with its id');

    // The proposal is rejected: nothing needs a person.
    assert.equal(gmod(bob, 'reject', 'not now').code, 0);
    const none = signalsOf(bob);
    assert.deepEqual(none.map(s => s.id).filter(id => id === stuckId || id === propId), []);
    assert.deepEqual(none, []);
  } finally { w.done(); }
});

// ---- the pane: the same "Needs you" as before ----
//
// The recorded statuses the mod's own tests use, and the pane's old logic
// (hooks/register.tsx before signals) written out, item by item: the proposal
// card, decision drafts, stalled jobs, then jobs main moved under.

const JOB = over => ({
  goal: 'A job', state: 'ready', stage: 0, stalled: false, tests: 'none', where: null, waiting: [], after: [], phase: null, moved: null,
  criteria: [{ text: 'it works', pass: null }], files: ['src/x.mjs'], ...over,
});
const PROPOSAL = {
  by: 'alice@x.io', at: '2026-10-31T10:05:00Z', summary: 'add slug-trim; change add-mul', headline: 'Slugs stay short enough for a URL.',
  assumptions: ['40 characters at most'], stale: false,
  diff: { added: [], changed: [], dropped: [], checks: [], phases: { added: [], changed: [], dropped: [] } },
  order: [], warnings: [], ready: true,
};
const STATUS = {
  governed: true,
  jobs: [
    JOB({ id: 'slugify', state: 'done', stage: 6, tests: 'green' }),
    JOB({ id: 'add-sum', state: 'claimed', stage: 2, stalled: true, tests: 'red', by: 'alice@x.io', where: 'agent-1' }),
    JOB({ id: 'add-mul', state: 'waiting', waiting: ['add-sum'], after: ['add-sum'] }),
  ],
  proposal: PROPOSAL,
  adrDrafts: [],
};
const clone2 = x => JSON.parse(JSON.stringify(x));
const MOVED = clone2(STATUS);
MOVED.jobs[1].moved = { level: 'breaks', behind: 1, landed: ['rename-field'], changed: ['src/schema.mjs'], touched: ['src/schema.mjs'], conflicts: [], failing: ['sum adds'] };
MOVED.jobs[1].stalled = false;
const CONFLICTS = clone2(STATUS);
CONFLICTS.proposal = null;
CONFLICTS.jobs[1].where = 'here';
CONFLICTS.jobs[0] = JOB({ id: 'slugify', state: 'claimed', stage: 1, where: 'elsewhere', moved: { level: 'conflicts', behind: 2, landed: [], changed: [], touched: [], conflicts: ['src/a.mjs', 'src/b.mjs'], failing: [] } });
const ADRS = clone2(STATUS);
ADRS.proposal = null;
ADRS.adrDrafts = [{ draft: 'cents-only', title: 'Money is integer cents', decision: 'x', scope: [], rules: [], supersedes: null, by: 'alice@x.io' }, { draft: 'utc', title: 'Times are UTC', decision: 'y', scope: [], rules: [], supersedes: null, by: 'bob@x.io' }];
const QUIET = clone2(STATUS);
QUIET.proposal = null;
QUIET.jobs[1].stalled = false;
QUIET.jobs[1].moved = { level: 'touched', behind: 1, landed: ['x'], changed: ['a'], touched: ['a'], conflicts: [], failing: [] };

function oldPane(s) {
  const jobs = s.jobs ?? [];
  const stalled = jobs.filter(j => j.stalled);
  const broken = jobs.filter(j => j.moved && ['conflicts', 'breaks'].includes(j.moved.level));
  const adrDrafts = s.adrDrafts ?? [];
  return [
    ...(s.proposal ? ['card'] : []),
    ...adrDrafts.map(d => `⚖ Decision waiting: ${d.title}`),
    ...stalled.map(j => `! ${j.id} is red${j.where && j.where !== 'here' ? ` in ${j.where}` : ''}: its criteria still fail`),
    ...broken.map(j => `! ${j.id}${j.moved.level === 'breaks'
      ? ` fails on today's main: ${j.moved.landed.join(', ') || 'main'} changed ${(j.moved.touched.length ? j.moved.touched : j.moved.changed).slice(0, 3).join(', ')}`
      : ` conflicts with main in ${j.moved.conflicts.join(', ')}`}${j.where && j.where !== 'here' ? ` (${j.where})` : ''}: rebase onto main`),
  ];
}
const newPane = s => signalsFrom(s).map(x => paneLine(x) ?? 'card');

test('the pane shows the same Needs-you items as before on recorded cases', () => {
  for (const [name, s] of Object.entries({ STATUS, MOVED, CONFLICTS, ADRS, QUIET, EMPTY: { governed: true, jobs: [] }, UNGOVERNED: { governed: false } })) {
    assert.deepEqual(newPane(s), oldPane(s), name);
  }
  // The wording, spelled out once.
  assert.deepEqual(newPane(MOVED), ['card', "! add-sum fails on today's main: rename-field changed src/schema.mjs (agent-1): rebase onto main"]);
  assert.deepEqual(newPane(STATUS), ['card', '! add-sum is red in agent-1: its criteria still fail']);
  assert.deepEqual(newPane(QUIET), []);
  // An ungoverned folder with a first draft still shows the card.
  assert.deepEqual(newPane({ governed: false, proposal: PROPOSAL }), ['card']);

  // Ids come from the cause: the same cause, the same id, whatever else changed.
  const a = signalsFrom(STATUS).find(x => x.cause.stuck === 'add-sum');
  const b = signalsFrom({ ...STATUS, jobs: [STATUS.jobs[1]], proposal: null }).find(x => x.cause.stuck === 'add-sum');
  assert.equal(a.id, b.id);
  const ids = signalsFrom(ADRS).map(x => x.id);
  assert.equal(new Set(ids).size, ids.length);
  // A new draft is a new cause.
  const p1 = signalsFrom(STATUS).find(x => 'proposal' in x.cause);
  const p2 = signalsFrom({ ...STATUS, proposal: { ...PROPOSAL, at: '2026-11-01T00:00:00Z' } }).find(x => 'proposal' in x.cause);
  assert.notEqual(p1.id, p2.id);
});

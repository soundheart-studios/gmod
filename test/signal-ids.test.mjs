// Stable signal ids (ADR 0002, docs/surfaces.md): a signal's id is a hash of
// its cause only, so with proposals, drafts and verdicts shared, the same
// signal has the same id on every clone and machine, and a mute or a decision
// made on one surface holds on all of them. The proposal signal also carries
// a `rev`: a hash of its content, which changes on every edit while the id
// stays, so a decision can name the version the person saw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signalsFrom } from '../lib/signals.mjs';

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
const NEG = { id: 'add-neg', goal: 'Negate', files: ['src/neg.mjs'], tests: ['test/neg.test.mjs'], done_when: [{ text: 'neg negates', check: 'sum' }] };
const DRAFT = { title: 'Sums never round', scope: ['src/**'], context: 'Money.', decision: 'No rounding.', rules: [{ level: 'must', text: 'never round inside sum' }] };

function clone(top, origin, name) {
  const dir = join(top, name);
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', `${name}@x.io`]);
  sh(dir, 'git', ['config', 'user.name', name]);
  return dir;
}

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-signal-ids-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = clone(top, origin, 'owner');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { top, alice: clone(top, origin, 'alice'), bob: clone(top, origin, 'bob'), done: () => rmSync(top, { recursive: true, force: true }) };
}

const signals = dir => JSON.parse(ok(dir, 'signals', '--json')).signals;
const byCause = (list, key) => list.find(s => key in s.cause);

test('two clones of one remote give identical ids for a proposal, an ADR draft and a red job', () => {
  const w = world();
  try {
    ok(w.alice, 'propose-job', JSON.stringify(NEG));
    ok(w.bob, 'adr', 'propose', JSON.stringify(DRAFT));
    gmod(w.alice, 'claim', 'add-sum');
    write(w.alice, { 'test/sum.test.mjs': "import { sum } from '../src/sum.mjs';\nif (sum(2, 3) !== 5) process.exit(1);\n" });
    gmod(w.alice, 'check');

    const a = signals(w.alice);
    const b = signals(w.bob);
    for (const key of ['proposal', 'adr', 'stuck']) {
      assert.ok(byCause(a, key), `alice has a ${key} signal`);
      assert.ok(byCause(b, key), `bob has a ${key} signal`);
      assert.equal(byCause(a, key).id, byCause(b, key).id, `the ${key} signal has one id on both clones`);
    }
    assert.equal(byCause(a, 'proposal').rev, byCause(b, 'proposal').rev, 'and the proposal one rev');
  } finally { w.done(); }
});

test('editing the proposal keeps its signal id and changes its rev', () => {
  const w = world();
  try {
    ok(w.alice, 'propose-job', JSON.stringify(NEG));
    const before = byCause(signals(w.alice), 'proposal');
    assert.match(before.rev ?? '', /^[0-9a-f]{8,}$/, 'the proposal signal carries a rev');
    assert.equal(byCause(signals(w.alice), 'proposal').rev, before.rev, 'reading again: same rev');

    ok(w.bob, 'edit-job', 'add-neg', JSON.stringify({ goal: 'Negate a number' }));
    const after = byCause(signals(w.alice), 'proposal');
    assert.equal(after.id, before.id, 'same proposal, same id');
    assert.notEqual(after.rev, before.rev, 'edited: a new rev');

    ok(w.alice, 'describe-proposal', '--summary', 'Negation.');
    const described = byCause(signals(w.bob), 'proposal');
    assert.equal(described.id, before.id);
    assert.notEqual(described.rev, after.rev, 'its description is part of what the person sees');
  } finally { w.done(); }
});

test('ids for the recorded 1.6 cases are unchanged', () => {
  // Causes and ids as gmod 1.6 gave them (the first matches a live proposal's
  // signal from 1.6.2), so mutes recorded by surfaces keep holding.
  const status = {
    proposal: { at: '2026-11-08T22:15:14.311Z', headline: 'h', ready: true, warnings: [] },
    adrDrafts: [{ draft: 'sums-never-round', title: 't', decision: 'd' }],
    jobs: [
      { id: 'add-sum', stalled: true, criteria: [{ text: 'sum adds', pass: false }], journal: [] },
      { id: 'add-mul', moved: { level: 'breaks', landed: ['x'], touched: ['a'], changed: [], failing: [] }, criteria: [], journal: [] },
    ],
  };
  assert.deepEqual(signalsFrom(status).map(s => [s.cause, s.id]), [
    [{ proposal: '2026-11-08T22:15:14.311Z' }, '6ca7ca5f'],
    [{ adr: 'sums-never-round' }, 'e980855e'],
    [{ stuck: 'add-sum' }, '9528422c'],
    [{ moved: 'add-mul', level: 'breaks' }, '05e2e860'],
  ]);
});

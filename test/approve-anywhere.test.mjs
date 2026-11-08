// A person's yes works wherever they are: on a job's branch, the decision is
// committed on main's tip, alone, and the job's checkout is left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

const PLAN = {
  main: 'main',
  checks: { sum: 'node test/sum.test.mjs' },
  jobs: [{ id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }] }],
};
const NEG = { id: 'add-neg', goal: 'Negate', files: ['src/neg.mjs'], tests: ['test/neg.test.mjs'], done_when: [{ text: 'neg negates', check: 'neg' }] };
const DRAFT = { title: 'Sums never round', scope: ['src/sum.mjs'], context: 'Money.', decision: 'No rounding.', rules: [{ level: 'must', text: 'never round inside sum' }] };

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-approve-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const alice = join(top, 'alice');
  sh(top, 'git', ['clone', '-q', origin, alice]);
  sh(alice, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(alice, 'git', ['config', 'user.name', 'alice']);
  write(alice, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n', 'README': 'x\n' });
  sh(alice, 'git', ['add', '-A']);
  sh(alice, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { alice, done: () => rmSync(top, { recursive: true, force: true }) };
}

// The job's checkout as it stands: branch, HEAD, index, working files.
function snapshot(dir) {
  return {
    branch: sh(dir, 'git', ['branch', '--show-current']),
    head: sh(dir, 'git', ['rev-parse', 'HEAD']),
    status: sh(dir, 'git', ['status', '--porcelain']),
    staged: sh(dir, 'git', ['diff', '--cached']),
    plan: readFileSync(join(dir, '.gmod/plan.json'), 'utf8'),
    code: readFileSync(join(dir, 'src/sum.mjs'), 'utf8'),
  };
}

// A job in progress: claimed, one change staged, one not.
function working(w) {
  assert.equal(gmod(w.alice, 'claim', 'add-sum').code, 0);
  write(w.alice, { 'src/sum.mjs': 'export const sum = (a, b) => a + b;\n', 'test/sum.test.mjs': 'process.exit(0);\n' });
  sh(w.alice, 'git', ['add', 'test/sum.test.mjs']);
  return snapshot(w.alice);
}

test("approve on a job's branch commits the plan on main's tip, publishes it, and leaves the checkout, index and branch as they were", () => {
  const w = world();
  try {
    const main = sh(w.alice, 'git', ['rev-parse', 'main']);
    const before = working(w);
    assert.match(before.branch, /^gmod\/add-sum$/);
    assert.match(gmod(w.alice, 'propose-job', JSON.stringify(NEG), '--checks', '{"neg":"node test/neg.test.mjs"}').out, /drafted: add add-neg/);

    const yes = gmod(w.alice, 'approve');
    assert.equal(yes.code, 0, yes.err);
    assert.match(yes.out, /approved: add add-neg \(commit (\w+) on gmod\/plan-\1\)/);
    const branch = yes.out.match(/on (gmod\/plan-\w+)/)[1];

    // The decision: one commit on main's tip, the plan alone.
    const commit = sh(w.alice, 'git', ['rev-parse', branch]);
    assert.equal(sh(w.alice, 'git', ['rev-parse', `${commit}^`]), main, "built on main's tip");
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s', commit]), 'plan: add add-neg');
    assert.equal(sh(w.alice, 'git', ['show', '--name-only', '--format=', commit]), '.gmod/plan.json', 'the plan travels alone');
    assert.match(sh(w.alice, 'git', ['show', `${commit}:.gmod/plan.json`]), /"add-neg"/);
    assert.equal(sh(w.alice, 'git', ['rev-parse', 'main']), commit, 'local main, checked out nowhere, moves to it');
    assert.equal(gmod(w.alice, 'proposal').out, 'no proposal');

    // The job's checkout: untouched, and no throwaway checkout left behind.
    assert.deepEqual(snapshot(w.alice), before);
    assert.equal(sh(w.alice, 'git', ['worktree', 'list', '--porcelain']).split('\n\n').length, 1);

    // A draft made against the job branch's older plan is refused, as before.
    gmod(w.alice, 'edit-job', 'add-sum', '{"goal":"Add"}');
    assert.match(gmod(w.alice, 'approve').err, /changed since the proposal/);
    assert.deepEqual(snapshot(w.alice), before);
  } finally { w.done(); }
});

test('approve on main behaves as before', () => {
  const w = world();
  try {
    assert.match(gmod(w.alice, 'propose-job', JSON.stringify(NEG), '--checks', '{"neg":"node test/neg.test.mjs"}').out, /drafted: add add-neg/);
    write(w.alice, { 'README': 'work in progress\n' });
    const yes = gmod(w.alice, 'approve');
    assert.equal(yes.code, 0, yes.err);
    assert.match(yes.out, /approved: add add-neg \(commit \w+ on main\)/);
    assert.equal(sh(w.alice, 'git', ['branch', '--show-current']), 'main');
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s']), 'plan: add add-neg');
    assert.equal(sh(w.alice, 'git', ['show', '--name-only', '--format=', 'HEAD']), '.gmod/plan.json');
    assert.equal(sh(w.alice, 'git', ['status', '--short']), 'M README', 'other work stays uncommitted');
    assert.match(readFileSync(join(w.alice, '.gmod/plan.json'), 'utf8'), /"add-neg"/);

    // Its working copy of the plan still counts: edited under a draft, refused.
    gmod(w.alice, 'edit-job', 'add-sum', '{"goal":"Add"}');
    write(w.alice, { '.gmod/plan.json': JSON.stringify(PLAN) });
    assert.match(gmod(w.alice, 'approve').err, /changed since the proposal/);
  } finally { w.done(); }
});

test("adr accept on a job's branch works the same way", () => {
  const w = world();
  try {
    const main = sh(w.alice, 'git', ['rev-parse', 'main']);
    const before = working(w);
    assert.equal(JSON.parse(gmod(w.alice, 'adr', 'propose', JSON.stringify(DRAFT), '--json').out).draft, 'sums-never-round');

    const yes = gmod(w.alice, 'adr', 'accept', 'sums-never-round');
    assert.equal(yes.code, 0, yes.err);
    assert.match(yes.out, /accepted ADR 0001: Sums never round/);
    const commit = sh(w.alice, 'git', ['rev-parse', 'gmod/adr-0001']);
    assert.equal(sh(w.alice, 'git', ['rev-parse', `${commit}^`]), main);
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s', commit]), 'adr: 0001 Sums never round');
    assert.equal(sh(w.alice, 'git', ['show', '--name-only', '--format=', commit]), 'docs/adr/0001-sums-never-round.md');
    assert.equal(sh(w.alice, 'git', ['rev-parse', 'main']), commit);
    assert.equal(gmod(w.alice, 'adr', 'drafts').out, 'no ADR drafts');

    assert.deepEqual(snapshot(w.alice), before);
    assert.equal(existsSync(join(w.alice, 'docs/adr/0001-sums-never-round.md')), false, "the job's checkout doesn't gain the file");
    assert.equal(sh(w.alice, 'git', ['worktree', 'list', '--porcelain']).split('\n\n').length, 1);
  } finally { w.done(); }
});

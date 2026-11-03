// End to end: a bare origin, two clones, the gmod command as people and CI run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
}
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
  checks: { sum: 'node test/sum.test.mjs' },
  jobs: [
    { id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }] },
    { id: 'add-mul', goal: 'Multiply', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }], after: ['add-sum'] },
  ],
};

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-test-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(top, 'seed');
  clone(origin, seed, 'owner@x.io');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n', 'README': 'x\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  const alice = join(top, 'alice');
  const bob = join(top, 'bob');
  clone(origin, alice, 'alice@x.io');
  clone(origin, bob, 'bob@x.io');
  return { top, origin, seed, alice, bob, done: () => rmSync(top, { recursive: true, force: true }) };
}

const TEST = "import { sum } from '../src/sum.mjs';\nif (sum(2, 3) !== 5) { console.error('sum(2,3) is', sum(2, 3)); process.exit(1); }\n";
const CODE = 'export const sum = (a, b) => a + b;\n';

test('version: the package version, and the image commit when there is one', () => {
  const pkg = JSON.parse(readFileSync(join(dirname(GMOD), '..', 'package.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'gmod-version-'));
  try {
    assert.equal(gmod(dir, 'version').out, `gmod ${pkg.version}`);
    assert.equal(gmod(dir, '--version').out, `gmod ${pkg.version}`, 'outside a repository too');
    const r = spawnSync('node', [GMOD, 'version', '--json'], { cwd: dir, env: { ...ENV, GMOD_COMMIT: 'abc1234' }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), { version: pkg.version, commit: 'abc1234' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('next, claim and the race for a claim', () => {
  const w = world();
  try {
    assert.match(gmod(w.alice, 'next').out, /^add-sum:/);
    assert.equal(gmod(w.alice, 'claim', 'add-sum').code, 0);
    const bob = gmod(w.bob, 'claim', 'add-sum');
    assert.equal(bob.code, 1);
    assert.match(bob.err, /claimed .*alice@x\.io/);
    assert.equal(gmod(w.bob, 'next').code, 1, 'add-mul waits for add-sum, add-sum is taken');
    assert.match(gmod(w.bob, 'claim', 'add-mul').err, /waits for add-sum/);
    assert.equal(gmod(w.alice, 'release').code, 0);
    assert.equal(gmod(w.bob, 'claim', 'add-sum').code, 0, 'released, bob takes it');
  } finally { w.done(); }
});

test('files outside the job and the plan itself are guarded', () => {
  const w = world();
  try {
    assert.match(gmod(w.alice, 'guard-path', 'src/sum.mjs').out, /claim a job/);
    gmod(w.alice, 'claim', 'add-sum');
    assert.equal(gmod(w.alice, 'guard-path', 'src/sum.mjs').code, 0);
    assert.equal(gmod(w.alice, 'guard-path', join(w.alice, 'test/sum.test.mjs')).code, 0);
    assert.match(gmod(w.alice, 'guard-path', 'README').out, /outside add-sum/);
    assert.match(gmod(w.alice, 'guard-path', '.gmod/plan.json').out, /allow-plan/);
    assert.equal(gmod(w.alice, 'guard-path', '.gmod/plan.json', '--allow-plan').code, 0);
    assert.equal(gmod(w.alice, 'guard-path', '/tmp/elsewhere').code, 0);
  } finally { w.done(); }
});

test('a commit needs red first, then green on exactly these files', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    write(w.alice, { 'src/sum.mjs': CODE, 'test/sum.test.mjs': TEST });
    assert.equal(gmod(w.alice, 'check').code, 0);
    assert.match(gmod(w.alice, 'gate-commit').out, /no failing run/);

    write(w.alice, { 'src/sum.mjs': 'export const sum = () => 0;\n' });
    assert.equal(gmod(w.alice, 'check').code, 1, 'red');
    write(w.alice, { 'src/sum.mjs': CODE });
    assert.match(gmod(w.alice, 'gate-commit').out, /last check failed/);
    assert.equal(gmod(w.alice, 'check').code, 0, 'green');
    assert.equal(gmod(w.alice, 'gate-commit').code, 0);
    write(w.alice, { 'src/sum.mjs': CODE + '// later\n' });
    assert.match(gmod(w.alice, 'gate-commit').out, /changed since/);
  } finally { w.done(); }
});

test("a red from other checks doesn't count once the plan's checks change", () => {
  const w = world();
  try {
    // The check is written wrong: it fails whatever the code does.
    const broken = { ...PLAN, checks: { sum: 'node test/no-such-file.mjs' } };
    write(w.alice, { '.gmod/plan.json': JSON.stringify(broken, null, 2) });
    gmod(w.alice, 'claim', 'add-sum');
    write(w.alice, { 'test/sum.test.mjs': TEST });
    assert.equal(gmod(w.alice, 'check').code, 1, 'red, but only because the check cannot run');

    // The check is fixed, the code written: green, yet that red proved nothing.
    write(w.alice, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': CODE });
    assert.equal(gmod(w.alice, 'check').code, 0);
    assert.match(gmod(w.alice, 'gate-commit').out, /checks changed since the failing run/);
    assert.equal(JSON.parse(gmod(w.alice, 'status', '--json').out).sawRed, false);

    // Seen failing under the real check, then passing: now it counts.
    write(w.alice, { 'src/sum.mjs': 'export const sum = () => 0;\n' });
    assert.equal(gmod(w.alice, 'check').code, 1);
    write(w.alice, { 'src/sum.mjs': CODE });
    assert.equal(gmod(w.alice, 'check').code, 0);
    assert.equal(gmod(w.alice, 'gate-commit').code, 0);
  } finally { w.done(); }
});

test('gmod commit finishes a job: only after red then green, pushed, as "<job>: …"', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    write(w.alice, { 'src/sum.mjs': CODE, 'test/sum.test.mjs': TEST });
    let r = gmod(w.alice, 'commit', '-m', 'sum adds', '--no-pr');
    assert.equal(r.code, 1);
    assert.match(r.err, /no failing run/);

    write(w.alice, { 'src/sum.mjs': 'export const sum = () => 0;\n' });
    gmod(w.alice, 'check');
    write(w.alice, { 'src/sum.mjs': CODE });
    gmod(w.alice, 'check');
    // The gate in front of a commit judges the worktree named, wherever it runs.
    assert.equal(gmod(w.bob, 'gate-commit', '--shell', '--dir', w.alice).code, 0);
    assert.equal(gmod(w.bob, 'gate-commit', '--shell').code, 1);

    r = gmod(w.alice, 'commit', '-m', 'sum adds', '--trailer', 'Co-Authored-By: A <a@x.io>', '--trailer', 'Refs: 1', '--no-pr');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /committed \w+ on gmod\/add-sum: add-sum: sum adds\npushed gmod\/add-sum/);
    const msg = sh(w.alice, 'git', ['log', '-1', '--format=%B', 'origin/gmod/add-sum']);
    assert.equal(msg, 'add-sum: sum adds\n\nCo-Authored-By: A <a@x.io>\nRefs: 1');
    assert.equal(sh(w.alice, 'git', ['status', '--porcelain']), '');
  } finally { w.done(); }
});

test('a CI change needs no job: edited and committed on its own, nothing else with it', () => {
  const w = world();
  try {
    assert.equal(gmod(w.alice, 'guard-path', '.gitea/workflows/gmod.yml').code, 0);
    assert.equal(gmod(w.alice, 'guard-path', '.gmod/protect.json').code, 0);
    assert.match(gmod(w.alice, 'guard-path', 'src/sum.mjs').out, /claim a job/);
    write(w.alice, { '.gitea/workflows/gmod.yml': 'name: gmod\n', '.gmod/protect.json': '{"require":["gate","review"]}' });
    sh(w.alice, 'git', ['add', '-A']);
    assert.equal(gmod(w.alice, 'gate-commit').code, 0);
    write(w.alice, { 'src/sum.mjs': CODE });
    sh(w.alice, 'git', ['add', '-A']);
    assert.match(gmod(w.alice, 'gate-commit').out, /claim a job first/);
  } finally { w.done(); }
});

test('CI: verify passes real work and refuses the rest', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    write(w.alice, { 'src/sum.mjs': CODE, 'test/sum.test.mjs': TEST });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-sum: sum adds']);
    const ok = gmod(w.alice, 'verify', '--base', 'origin/main', '--branch', 'gmod/add-sum');
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /criteria fail/);

    // A test that passes whatever the code does proves nothing.
    write(w.alice, { 'test/sum.test.mjs': 'process.exit(0);\n' });
    sh(w.alice, 'git', ['commit', '-q', '-am', 'add-sum: weaker test']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /❌ .*criteria fail \(none failed\)/);

    // A file outside the job.
    write(w.alice, { 'test/sum.test.mjs': TEST, 'README': 'changed\n' });
    sh(w.alice, 'git', ['commit', '-q', '-am', 'add-sum: and the readme']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /outside the job: README/);

    // No claim.
    const bob = gmod(w.bob, 'verify', '--base', 'origin/main', '--head', 'HEAD', '--title', 'add-sum: x');
    assert.match(bob.out, /nothing to show|no code|nobody claimed|nothing changed between/);
  } finally { w.done(); }
});

test('CI: a plan change travels alone', () => {
  const w = world();
  try {
    const plan = { ...PLAN, jobs: [...PLAN.jobs, { id: 'docs', goal: 'Docs', files: ['docs/**'], done_when: [{ text: 'x', check: 'sum' }] }] };
    write(w.alice, { '.gmod/plan.json': JSON.stringify(plan) });
    sh(w.alice, 'git', ['commit', '-q', '-am', 'plan docs']);
    const ok = gmod(w.alice, 'verify', '--base', 'origin/main');
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /the review checks it weakens nothing/);
    write(w.alice, { 'src/sum.mjs': CODE });
    sh(w.alice, 'git', ['commit', '-q', '-am', 'and some code']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /only the plan.*src\/sum\.mjs/);
  } finally { w.done(); }
});

test('done on main frees the next job and sweeps the claim', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    write(w.alice, { 'src/sum.mjs': CODE, 'test/sum.test.mjs': TEST });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-sum: sum adds']);
    sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    sh(w.bob, 'git', ['fetch', '-q', 'origin']);
    assert.match(gmod(w.bob, 'next').out, /^add-mul:/);
    assert.match(gmod(w.bob, 'sweep').out, /released add-sum/);
    assert.equal(sh(w.bob, 'git', ['ls-remote', 'origin', 'refs/gmod/claims/*']), '');
  } finally { w.done(); }
});

test('a subagent in its own worktree claims its own job and answers to it', () => {
  const w = world();
  try {
    // A second ready job, so two workers can run side by side.
    const plan = structuredClone(PLAN);
    plan.jobs.push({ id: 'docs', goal: 'Write docs', files: ['docs/**'], done_when: [{ text: 'sum adds', check: 'sum' }] });
    write(w.alice, { '.gmod/plan.json': JSON.stringify(plan) });
    sh(w.alice, 'git', ['commit', '-q', '-am', 'plan docs']);
    sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    const wt = join(w.top, 'alice-wt');
    sh(w.alice, 'git', ['worktree', 'add', '-q', '-b', 'side', wt]);

    assert.equal(gmod(w.alice, 'claim', 'add-sum').code, 0);
    assert.equal(gmod(wt, 'claim', 'docs').code, 0, 'the worktree holds a claim of its own');
    // The file's own worktree decides, wherever the question is asked from.
    assert.equal(gmod(w.alice, 'guard-path', join(wt, 'docs/a.md')).code, 0);
    assert.match(gmod(w.alice, 'guard-path', join(wt, 'src/sum.mjs')).out, /outside docs/);
    assert.equal(gmod(wt, 'guard-path', join(w.alice, 'src/sum.mjs')).code, 0);
    assert.match(gmod(wt, 'guard-path', join(w.alice, 'docs/a.md')).out, /outside add-sum/);
    // gmod's own records can't be written around it.
    assert.match(gmod(w.alice, 'guard-path', join(w.alice, '.git/gmod/claim.json')).out, /own records/);
    assert.match(gmod(w.alice, 'guard-path', join(w.alice, '.git/worktrees/alice-wt/gmod/evidence/docs.json')).out, /own records/);
    assert.equal(gmod(w.alice, 'guard-path', join(w.alice, '.git/config')).code, 0);
  } finally { w.done(); }
});

test('the commit gate runs in the shell it guards', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    write(w.alice, { 'src/sum.mjs': CODE });
    const r = gmod(w.alice, 'gate-commit', '--shell');
    assert.equal(r.code, 1);
    assert.match(r.err, /gmod refused the commit: add-sum: no failing run/);
  } finally { w.done(); }
});

test('the agent drafts the plan, a person approves it, and it lands alone', () => {
  const w = world();
  try {
    const job = { id: 'add-neg', goal: 'Negate', files: ['src/neg.mjs'], tests: ['test/neg.test.mjs'], done_when: [{ text: 'neg negates', check: 'neg' }], after: ['add-sum'] };
    assert.match(gmod(w.alice, 'propose-job', JSON.stringify(job)).err, /check "neg" isn't defined/, 'a criterion needs its check');
    assert.match(gmod(w.alice, 'propose-job', JSON.stringify(job), '--checks', '{"neg":"node test/neg.test.mjs"}').out, /drafted: add add-neg/);
    assert.match(gmod(w.alice, 'edit-job', 'add-mul', '{"goal":"Multiply two numbers"}').out, /add add-neg; change add-mul/);
    const shown = gmod(w.alice, 'proposal').out;
    assert.match(shown, /\+ add-neg: Negate \(after add-sum\)\n {6}done when: neg negates/);
    assert.match(shown, /~ add-mul\n {6}goal: Multiply → Multiply two numbers/);
    assert.match(gmod(w.alice, 'drop-job', 'add-sum').err, /add-mul, add-neg wait for add-sum/);
    assert.match(gmod(w.alice, 'plan', '--no-sync').out, /proposal by alice@x\.io: add add-neg; change add-mul/);

    // The draft isn't the plan until a person says yes, and never on a job's branch.
    assert.doesNotMatch(gmod(w.alice, 'next').out, /add-neg/);
    gmod(w.alice, 'claim', 'add-sum');
    assert.match(gmod(w.alice, 'approve').err, /a job's branch/);
    sh(w.alice, 'git', ['switch', '-q', 'main']);
    write(w.alice, { 'README': 'work in progress\n' });
    const yes = gmod(w.alice, 'approve');
    assert.equal(yes.code, 0, yes.err);
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s']), 'plan: add add-neg; change add-mul');
    assert.equal(sh(w.alice, 'git', ['show', '--name-only', '--format=', 'HEAD']), '.gmod/plan.json', 'the plan travels alone');
    assert.equal(sh(w.alice, 'git', ['status', '--short']), 'M README', 'other work stays uncommitted');
    assert.equal(gmod(w.alice, 'proposal').out, 'no proposal');

    // A draft whose plan moved underneath it is refused; a no drops it.
    gmod(w.alice, 'edit-job', 'add-mul', '{"goal":"Times"}');
    write(w.alice, { '.gmod/plan.json': JSON.stringify(PLAN) });
    assert.match(gmod(w.alice, 'approve').err, /changed since the proposal/);
    assert.match(gmod(w.alice, 'reject', 'not', 'now').out, /rejected: .*change add-mul \(not now\)/);
  } finally { w.done(); }
});

test('a plan can start from nothing', () => {
  const top = mkdtempSync(join(tmpdir(), 'gmod-fresh-'));
  try {
    sh(top, 'git', ['init', '-q', '-b', 'main']);
    sh(top, 'git', ['config', 'user.email', 'o@x.io']);
    sh(top, 'git', ['commit', '-q', '--allow-empty', '-m', 'start']);
    const job = { id: 'hello', goal: 'Say hello', files: ['hello.sh'], done_when: [{ text: 'it says hello', check: 'hi' }] };
    assert.equal(gmod(top, 'propose-job', JSON.stringify(job), '--checks', '{"hi":"sh hello.sh | grep -q hello"}').code, 0);
    assert.match(gmod(top, 'approve').out, /approved: add hello/);
    assert.match(gmod(top, 'next').out, /^hello:/);
  } finally { rmSync(top, { recursive: true, force: true }); }
});

test('the proposal explains itself: why, what it assumes, what to watch for', () => {
  const w = world();
  try {
    const a = { id: 'trim', goal: 'Trim', files: ['src/**'], done_when: [{ text: 'trims', check: 'sum' }] };
    const b = { id: 'pad', goal: 'Pad', files: ['src/pad.mjs'], tests: ['test/pad.test.mjs'], done_when: [{ text: 'pads', check: 'sum' }] };
    gmod(w.alice, 'propose-job', JSON.stringify(a));
    gmod(w.alice, 'propose-job', JSON.stringify(b));
    gmod(w.alice, 'describe-proposal', '--summary', 'Strings fit their boxes.', '--assumptions', '["40 characters","spaces pad"]');
    const p = JSON.parse(gmod(w.alice, 'proposal', '--json').out);
    assert.equal(p.headline, 'Strings fit their boxes.');
    assert.deepEqual(p.assumptions, ['40 characters', 'spaces pad']);
    assert.ok(p.warnings.some(x => /trim and pad change the same files/.test(x)), p.warnings.join('\n'));
    assert.ok(p.warnings.some(x => /trim lists no test files/.test(x)));
    assert.deepEqual(p.order.find(o => o.id === 'trim'), { id: 'trim', phase: null, after: [], waits: [], now: true });
    // Ordered, they no longer clash.
    gmod(w.alice, 'edit-job', 'pad', '{"after":["trim"]}');
    const q = JSON.parse(gmod(w.alice, 'proposal', '--json').out);
    assert.ok(!q.warnings.some(x => /trim and pad/.test(x)), q.warnings.join('\n'));
    assert.deepEqual(q.order.find(o => o.id === 'pad').waits, ['trim']);
    gmod(w.alice, 'drop-job', 'pad', '--reason', 'not needed yet');
    assert.match(gmod(w.alice, 'proposal').out, /add trim\n[\s\S]*/);
  } finally { w.done(); }
});

test('the board follows every job through its stages, in every worktree', () => {
  const w = world();
  try {
    const plan = structuredClone(PLAN);
    plan.jobs.push({ id: 'docs', goal: 'Docs', files: ['docs/**'], tests: ['test/docs.test.mjs'], done_when: [{ text: 'docs exist', check: 'docs' }] });
    plan.checks.docs = 'test -f docs/a.md';
    write(w.alice, { '.gmod/plan.json': JSON.stringify(plan) });
    sh(w.alice, 'git', ['commit', '-q', '-am', 'plan docs']);
    sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    const wt = join(w.top, 'agent-1');
    sh(w.alice, 'git', ['worktree', 'add', '-q', '-b', 'side', wt]);
    const stage = id => JSON.parse(gmod(w.alice, 'status', '--no-sync').out).jobs.find(j => j.id === id);

    assert.equal(stage('add-sum').stage, 0);
    gmod(w.alice, 'claim', 'add-sum');
    gmod(wt, 'claim', 'docs');
    assert.deepEqual([stage('add-sum').stage, stage('add-sum').where], [1, 'here']);
    assert.deepEqual([stage('docs').stage, stage('docs').where], [1, 'agent-1']);

    gmod(wt, 'check');
    assert.equal(stage('docs').stage, 2, 'red');
    assert.equal(stage('docs').criteria[0].pass, false);
    write(wt, { 'docs/a.md': '# docs\n' });
    gmod(wt, 'check');
    assert.equal(stage('docs').stage, 3, 'green');
    sh(wt, 'git', ['add', '-A']);
    sh(wt, 'git', ['commit', '-q', '-m', 'docs: write them']);
    assert.equal(stage('docs').stage, 4, 'committed');
    sh(wt, 'git', ['push', '-q', 'origin', 'gmod/docs']);
    assert.equal(stage('docs').stage, 5, 'pushed');
    sh(wt, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    sh(w.alice, 'git', ['fetch', '-q', 'origin']);
    assert.equal(stage('docs').stage, 6, 'merged');
    assert.equal(stage('add-mul').state, 'waiting');
  } finally { w.done(); }
});

const PHASED = {
  main: 'main',
  checks: { sum: 'node test/sum.test.mjs' },
  phases: [
    { id: 'basics', title: 'Basics', outcome: 'Numbers add up' },
    { id: 'more', title: 'More', outcome: 'Numbers multiply too', after: ['basics'] },
  ],
  jobs: [
    { id: 'add-sum', phase: 'basics', goal: 'Add two numbers', files: ['src/sum.mjs'], tests: ['test/sum.test.mjs'], done_when: [{ text: 'sum adds', check: 'sum' }] },
    { id: 'add-docs', phase: 'basics', goal: 'Document sum', files: ['docs/**'], tests: ['test/docs.test.mjs'], done_when: [{ text: 'sum adds', check: 'sum' }] },
    { id: 'add-mul', phase: 'more', goal: 'Multiply', files: ['src/mul.mjs'], tests: ['test/mul.test.mjs'], done_when: [{ text: 'sum adds', check: 'sum' }] },
  ],
};

function phasedWorld() {
  const w = world();
  write(w.alice, { '.gmod/plan.json': JSON.stringify(PHASED) });
  sh(w.alice, 'git', ['commit', '-q', '-am', 'phased plan']);
  sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return w;
}

test('phases: checked, ordered, and every job of a phase waits for the phase before', () => {
  const w = phasedWorld();
  try {
    const st = () => JSON.parse(gmod(w.alice, 'status', '--no-sync').out);
    assert.deepEqual(st().jobs.find(j => j.id === 'add-mul').waiting, ['add-sum', 'add-docs']);
    assert.deepEqual(st().phases.map(p => [p.id, p.state, p.done, p.total]), [['basics', 'ready', 0, 2], ['more', 'waiting', 0, 1]]);
    assert.match(gmod(w.alice, 'claim', 'add-mul').err, /waits for add-sum, add-docs/);
    assert.match(gmod(w.alice, 'plan', '--no-sync').out, /^Basics · 0 of 2 done\n  Numbers add up\n  ready +add-sum/m);

    // Finish one job of basics: more still waits for the other.
    sh(w.alice, 'git', ['commit', '-q', '--allow-empty', '-m', 'add-sum: done']);
    sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    sh(w.alice, 'git', ['fetch', '-q', 'origin']);
    assert.deepEqual(st().jobs.find(j => j.id === 'add-mul').waiting, ['add-docs']);
    assert.equal(st().phases[0].state, 'ready');
    sh(w.alice, 'git', ['commit', '-q', '--allow-empty', '-m', 'add-docs: done']);
    sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    sh(w.alice, 'git', ['fetch', '-q', 'origin']);
    assert.deepEqual(st().phases.map(p => p.state), ['done', 'ready']);
    assert.match(gmod(w.alice, 'next').out, /^add-mul:/);
  } finally { w.done(); }
});

test('phases: the CI gate refuses a job whose phase comes too early', () => {
  const w = phasedWorld();
  try {
    gmod(w.alice, 'claim', 'add-mul', '--no-branch');
    write(w.alice, { 'src/mul.mjs': 'export const mul = (a, b) => a * b;\n', 'test/mul.test.mjs': 'process.exit(0);\n' });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-mul: multiply']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /❌ waits for add-sum, add-docs, not yet on main/);
  } finally { w.done(); }
});

test('phases: a plan that loops, or names what is not there, is refused', () => {
  const w = world();
  try {
    const loop = structuredClone(PHASED);
    loop.phases[0].after = ['more'];
    write(w.alice, { '.gmod/plan.json': JSON.stringify(loop) });
    assert.match(gmod(w.alice, 'plan', '--no-sync').err, /the order goes in a circle/);
    const lost = structuredClone(PHASED);
    lost.jobs[0].phase = 'nowhere';
    write(w.alice, { '.gmod/plan.json': JSON.stringify(lost) });
    assert.match(gmod(w.alice, 'plan', '--no-sync').err, /add-sum: "phase" names unknown phase nowhere/);
    const loose = structuredClone(PHASED);
    delete loose.jobs[1].phase;
    write(w.alice, { '.gmod/plan.json': JSON.stringify(loose) });
    assert.match(gmod(w.alice, 'plan', '--no-sync').err, /job add-docs isn't in a phase yet/);
  } finally { w.done(); }
});

test('phases: drafted a step at a time, approved only once whole', () => {
  const w = world();
  try {
    // Turn the flat plan into phases: the steps in between are fine as a draft.
    assert.match(gmod(w.alice, 'propose-phase', '{"id":"basics","title":"Basics","outcome":"Numbers add up"}').out, /drafted: add phase basics/);
    const p = JSON.parse(gmod(w.alice, 'proposal', '--json').out);
    assert.equal(p.ready, false);
    assert.ok(p.warnings.some(x => /not ready to approve: job add-sum isn't in a phase yet/.test(x)), p.warnings.join('\n'));
    assert.match(gmod(w.alice, 'approve').err, /add-sum isn't in a phase yet/);
    gmod(w.alice, 'edit-job', 'add-sum', '{"phase":"basics"}');
    gmod(w.alice, 'edit-job', 'add-mul', '{"phase":"basics"}');
    assert.equal(JSON.parse(gmod(w.alice, 'proposal', '--json').out).ready, true);
    assert.match(gmod(w.alice, 'drop-phase', 'basics').err, /add-sum, add-mul are in basics/);
    assert.match(gmod(w.alice, 'proposal').out, /\+ phase basics: Numbers add up/);
    const yes = gmod(w.alice, 'approve');
    assert.equal(yes.code, 0, yes.err);
    assert.match(yes.out, /approved: add phase basics; change add-sum, add-mul/);
  } finally { w.done(); }
});

// ---- main moved under you ----

const SHARED = {
  main: 'main',
  contracts: ['src/schema.mjs'],
  checks: { cols: 'node test/b.test.mjs', ok: 'true' },
  jobs: [
    { id: 'rename-field', goal: 'Rename the field', files: ['src/schema.mjs', 'src/shared.mjs'], tests: ['test/x.test.mjs'], done_when: [{ text: 'renamed', check: 'ok' }] },
    { id: 'columns', goal: 'List the columns', files: ['src/b.mjs', 'src/shared.mjs'], tests: ['test/b.test.mjs'], done_when: [{ text: 'columns are the fields', check: 'cols' }] },
  ],
};

function sharedWorld() {
  const w = world();
  write(w.alice, {
    '.gmod/plan.json': JSON.stringify(SHARED),
    'src/schema.mjs': "export const FIELDS = ['title'];\n",
    'src/shared.mjs': 'export const shared = 1;\n',
  });
  sh(w.alice, 'git', ['add', '-A']);
  sh(w.alice, 'git', ['commit', '-q', '-m', 'shared plan']);
  sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  sh(w.bob, 'git', ['pull', '-q', 'origin', 'main']);
  // bob works on columns, built on the schema, red then green.
  gmod(w.bob, 'claim', 'columns', '--no-branch');
  write(w.bob, { 'test/b.test.mjs': "import { columns } from '../src/b.mjs';\nif (columns() !== 'title') { console.error('columns are', columns()); process.exit(1); }\n" });
  gmod(w.bob, 'check');
  write(w.bob, { 'src/b.mjs': "import { FIELDS } from './schema.mjs';\nexport const columns = () => FIELDS.join(',');\n" });
  assert.equal(gmod(w.bob, 'check').code, 0);
  return w;
}

const movedOf = (dir, ...extra) => JSON.parse(gmod(dir, 'moved', '--json', ...extra).out).find(m => m.job === 'columns');
function land(w, files, subject) {
  sh(w.alice, 'git', ['pull', '-q', 'origin', 'main']);
  write(w.alice, files);
  sh(w.alice, 'git', ['add', '-A']);
  sh(w.alice, 'git', ['commit', '-q', '-m', subject]);
  sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
}

test('moved under you: fresh, then behind when something unrelated lands', () => {
  const w = sharedWorld();
  try {
    assert.equal(movedOf(w.bob).level, 'fresh');
    land(w, { 'README': 'more\n' }, 'docs: a readme');
    const m = movedOf(w.bob);
    assert.deepEqual([m.level, m.behind], ['behind', 1]);
    assert.equal(gmod(w.bob, 'notice', join(w.bob, 'src/b.mjs')).out, '', 'nothing worth saying');
  } finally { w.done(); }
});

test('moved under you: a contract changes, and the job breaks on it', () => {
  const w = sharedWorld();
  try {
    land(w, { 'src/schema.mjs': "export const FIELDS = ['name'];\n" }, 'rename-field: title is now name');
    // Without running the checks: touched, naming what landed and what it changed.
    let m = movedOf(w.bob);
    assert.deepEqual([m.level, m.landed, m.touched, m.checked], ['touched', ['rename-field'], ['src/schema.mjs'], false]);
    // Running them on the work merged onto the new main: it breaks.
    m = movedOf(w.bob, '--run');
    assert.deepEqual([m.level, m.failing], ['breaks', ['columns are the fields']]);
    // Remembered: no need to run again for the same main and the same work.
    assert.equal(movedOf(w.bob).level, 'breaks');

    // The agent is told once, on its next step, in words.
    const told = gmod(w.bob, 'notice', join(w.bob, 'src/b.mjs')).out;
    assert.match(told, /rename-field landed on main and changed src\/schema\.mjs/);
    assert.match(told, /columns are the fields.*fails/);
    assert.match(told, /Rebase onto origin\/main/);
    assert.equal(gmod(w.bob, 'notice', join(w.bob, 'src/b.mjs')).out, '', 'told once');

    // A commit is refused while it breaks.
    assert.match(gmod(w.bob, 'gate-commit').out, /fails on today's main/);

    // Rebased onto the new main and fixed, it's fresh again.
    sh(w.bob, 'git', ['add', '-A']);
    sh(w.bob, 'git', ['commit', '-q', '--no-verify', '-m', 'columns: wip']);
    sh(w.bob, 'git', ['pull', '-q', '--rebase', 'origin', 'main']);
    assert.equal(movedOf(w.bob).level, 'fresh');
  } finally { w.done(); }
});

test('moved under you: what landed conflicts with the work in progress', () => {
  const w = sharedWorld();
  try {
    write(w.bob, { 'src/shared.mjs': 'export const shared = 2;\n' });
    land(w, { 'src/shared.mjs': 'export const shared = 3;\n' }, 'rename-field: bump shared');
    const m = movedOf(w.bob);
    assert.deepEqual([m.level, m.conflicts], ['conflicts', ['src/shared.mjs']]);
    assert.match(gmod(w.bob, 'notice', w.bob).out, /conflicts with main in src\/shared\.mjs/);
  } finally { w.done(); }
});

test('moved under you: the board carries it for the pane', () => {
  const w = sharedWorld();
  try {
    land(w, { 'src/schema.mjs': "export const FIELDS = ['name'];\n" }, 'rename-field: title is now name');
    gmod(w.bob, 'moved', '--run');
    const job = JSON.parse(gmod(w.bob, 'status', '--no-sync').out).jobs.find(j => j.id === 'columns');
    assert.deepEqual([job.moved.level, job.moved.landed, job.moved.failing], ['breaks', ['rename-field'], ['columns are the fields']]);
  } finally { w.done(); }
});

test('moved under you: a hidden dependency (not its files, not a contract) still breaks it', () => {
  const w = sharedWorld();
  try {
    // columns uses src/schema.mjs; here the plan doesn't declare it a contract.
    const plan = structuredClone(SHARED);
    delete plan.contracts;
    land(w, { '.gmod/plan.json': JSON.stringify(plan) }, 'plan: drop the contract');
    sh(w.bob, 'git', ['add', '-A']);
    sh(w.bob, 'git', ['commit', '-q', '--no-verify', '-m', 'columns: wip']);
    sh(w.bob, 'git', ['pull', '-q', '--rebase', 'origin', 'main']);
    land(w, { 'src/schema.mjs': "export const FIELDS = ['name'];\n" }, 'rename-field: title is now name');
    assert.equal(movedOf(w.bob).level, 'behind', 'without the checks, nothing points at it');
    const m = movedOf(w.bob, '--run');
    assert.deepEqual([m.level, m.touched, m.failing], ['breaks', [], ['columns are the fields']]);
    assert.match(gmod(w.bob, 'notice', w.bob).out, /rename-field landed on main and changed src\/schema\.mjs\. On today's main, "columns are the fields" fails/);
  } finally { w.done(); }
});

test('moved under you: names a job that joined the plan after this one started, skips plan files, ignores finished jobs', () => {
  const w = sharedWorld();
  try {
    // A new job is planned and lands after bob's work began: bob's own copy
    // of the plan doesn't know it.
    const plan = structuredClone(SHARED);
    plan.jobs.push({ id: 'retitle', goal: 'Retitle', files: ['src/schema.mjs'], tests: ['test/r.test.mjs'], done_when: [{ text: 'ok', check: 'ok' }] });
    land(w, { '.gmod/plan.json': JSON.stringify(plan), 'src/schema.mjs': "export const FIELDS = ['name'];\n" }, 'retitle: title is now name');
    const m = movedOf(w.bob, '--run');
    assert.deepEqual([m.level, m.landed], ['breaks', ['retitle']]);
    const told = gmod(w.bob, 'notice', w.bob).out;
    assert.match(told, /^gmod: retitle landed on main and changed src\/schema\.mjs\. On today's main, "columns are the fields" fails for columns/);
    assert.doesNotMatch(told, /\.gmod\/plan\.json/);

    // alice's own job landed: her leftover claim isn't checked against main.
    sh(w.alice, 'git', ['fetch', '-q', 'origin']);
    gmod(w.alice, 'claim', 'rename-field', '--no-branch');
    land(w, { 'src/shared.mjs': 'export const shared = 9;\n' }, 'rename-field: done');
    assert.equal(JSON.parse(gmod(w.alice, 'moved', '--json').out).some(x => x.job === 'rename-field'), false);
  } finally { w.done(); }
});

test('gap 3: when a job breaks, the notice says an outdated criterion is a plan change, not a test to bend', () => {
  const w = sharedWorld();
  try {
    land(w, { 'src/schema.mjs': "export const FIELDS = ['name'];\n" }, 'rename-field: title is now name');
    movedOf(w.bob, '--run');
    assert.match(gmod(w.bob, 'notice', w.bob).out, /If a criterion itself no longer fits what landed, don't bend the test: draft the change with mcp__gmod__edit_job and tell the person\./);
  } finally { w.done(); }
});

test('gap 2: CI refuses a job whose commits are not by whoever claimed it', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    // bob does the work on alice's claim.
    sh(w.bob, 'git', ['fetch', '-q', 'origin', '+refs/gmod/claims/*:refs/gmod/claims/*']);
    sh(w.bob, 'git', ['switch', '-q', '-c', 'gmod/add-sum']);
    write(w.bob, { 'src/sum.mjs': CODE, 'test/sum.test.mjs': TEST });
    sh(w.bob, 'git', ['add', '-A']);
    sh(w.bob, 'git', ['commit', '-q', '-m', 'add-sum: sum adds']);
    const r = gmod(w.bob, 'verify', '--base', 'origin/main', '--branch', 'gmod/add-sum');
    assert.equal(r.code, 1);
    assert.match(r.out, /❌ claimed by alice@x\.io, but its commits are by bob@x\.io/);

    // alice's own work on her claim passes that line.
    write(w.alice, { 'src/sum.mjs': CODE, 'test/sum.test.mjs': TEST });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-sum: sum adds']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /✅ claimed by alice@x\.io, who made its commits/);

    // The forge's "update branch" merges main in as someone else: main's work, not the job's.
    write(w.seed, { 'README': 'moved on\n' });
    sh(w.seed, 'git', ['commit', '-q', '-am', 'docs']);
    sh(w.seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    sh(w.alice, 'git', ['fetch', '-q', 'origin']);
    sh(w.alice, 'git', ['-c', 'user.email=forge@x.io', 'merge', '-q', '--no-edit', 'origin/main']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /✅ claimed by alice@x\.io, who made its commits/);
  } finally { w.done(); }
});

test('CI says why a criterion fails with the change', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    write(w.alice, { 'src/sum.mjs': 'export const sum = (a, b) => a - b;\n', 'test/sum.test.mjs': TEST });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-sum: sum adds']);
    const r = gmod(w.alice, 'verify', '--base', 'origin/main', '--branch', 'gmod/add-sum');
    assert.match(r.out, /❌ the criteria pass with the change \(0\/1\)\n  - "sum adds" fails:\n\n    ```\n    sum\(2,3\) is -1\n    ```/);
  } finally { w.done(); }
});

test('gap 6: a CI change travels alone, for the owners to review', () => {
  const w = world();
  try {
    write(w.alice, { '.gitea/workflows/gmod.yml': 'name: gmod\n', '.gitea/CODEOWNERS': '/.gmod/ @alice\n' });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'ci: the gate']);
    const ok = gmod(w.alice, 'verify', '--base', 'origin/main');
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /✅ a CI change on its own/);
    assert.match(ok.out, /the review checks it weakens nothing that is checked/);

    write(w.alice, { 'src/sum.mjs': CODE });
    sh(w.alice, 'git', ['commit', '-q', '-am', 'ci: and some code']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /❌ a CI change carries only CI files; also changed: src\/sum\.mjs/);
  } finally { w.done(); }
});

// ---- gap 1: ADRs ----

const DRAFT = {
  title: 'Sums never round',
  scope: ['src/sum.mjs', 'src/mul.mjs'],
  context: 'Money adds up through these.',
  decision: 'Arithmetic stays exact: no rounding inside src/.',
  rules: [{ level: 'must', text: 'never round inside sum or mul' }, { level: 'should', text: 'say so in a comment where precision matters' }],
};

test('ADRs: drafted by the agent, accepted by a person, numbered and committed alone', () => {
  const w = world();
  try {
    const d = JSON.parse(gmod(w.alice, 'adr', 'propose', JSON.stringify(DRAFT), '--json').out);
    assert.equal(d.draft, 'sums-never-round');
    assert.match(gmod(w.alice, 'adr', 'drafts').out, /sums-never-round: Sums never round\n {2}must: never round inside sum or mul/);
    assert.match(gmod(w.alice, 'adr', 'propose', JSON.stringify({ ...DRAFT, rules: [] })).err, /at least one rule/);

    const yes = gmod(w.alice, 'adr', 'accept', 'sums-never-round');
    assert.equal(yes.code, 0, yes.err);
    assert.match(yes.out, /accepted ADR 0001: Sums never round/);
    const file = readFileSync(join(w.alice, 'docs/adr/0001-sums-never-round.md'), 'utf8');
    assert.match(file, /^---\nid: 0001\ntitle: Sums never round\nstatus: accepted\nscope: src\/sum\.mjs, src\/mul\.mjs\n/);
    assert.match(file, /## Rules\n- must: never round inside sum or mul\n- should: say so in a comment where precision matters/);
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s']), 'adr: 0001 Sums never round');
    assert.equal(sh(w.alice, 'git', ['show', '--name-only', '--format=', 'HEAD']), 'docs/adr/0001-sums-never-round.md');

    // A later one supersedes it: the old one says so.
    gmod(w.alice, 'adr', 'propose', JSON.stringify({ ...DRAFT, title: 'Sums round to cents', supersedes: '0001', rules: [{ level: 'must', text: 'round to cents at the edge only' }] }));
    assert.match(gmod(w.alice, 'adr', 'accept', 'sums-round-to-cents').out, /accepted ADR 0002: Sums round to cents \(supersedes 0001\)/);
    assert.match(readFileSync(join(w.alice, 'docs/adr/0001-sums-never-round.md'), 'utf8'), /status: superseded\nsuperseded_by: 0002/);
    assert.match(gmod(w.alice, 'adr', 'list').out, /^0001 superseded +Sums never round\n0002 accepted +Sums round to cents/m);

    // Rejected drafts just go.
    gmod(w.alice, 'adr', 'propose', JSON.stringify({ ...DRAFT, title: 'Nope' }));
    assert.match(gmod(w.alice, 'adr', 'reject', 'nope', 'not now').out, /rejected nope \(not now\)/);
    assert.equal(gmod(w.alice, 'adr', 'drafts').out, 'no ADR drafts');
  } finally { w.done(); }
});

test('ADRs: the job is told the rules that apply to it, and the gate names them', () => {
  const w = world();
  try {
    gmod(w.alice, 'adr', 'propose', JSON.stringify(DRAFT));
    sh(w.alice, 'git', ['switch', '-q', '-c', 'adr-branch']);
    gmod(w.alice, 'adr', 'accept', 'sums-never-round');
    sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    sh(w.alice, 'git', ['switch', '-q', 'main']);
    sh(w.alice, 'git', ['pull', '-q', 'origin', 'main']);

    gmod(w.alice, 'claim', 'add-sum');
    const st = JSON.parse(gmod(w.alice, 'status', '--no-sync').out);
    assert.deepEqual(st.claim.adrs.map(a => [a.id, a.title, a.rules.map(r => r.level)]), [['0001', 'Sums never round', ['must', 'should']]]);
    assert.deepEqual(JSON.parse(gmod(w.alice, 'adr', 'for', 'src/sum.mjs', '--json').out).map(a => a.id), ['0001']);
    assert.deepEqual(JSON.parse(gmod(w.alice, 'adr', 'for', 'README', '--json').out), []);

    write(w.alice, { 'src/sum.mjs': CODE, 'test/sum.test.mjs': TEST });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-sum: sum adds']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /ℹ️ falls under ADR 0001 \(Sums never round\): must never round inside sum or mul/);
  } finally { w.done(); }
});

test('ADRs: an ADR-only pull request travels alone; mixed with code it is refused', () => {
  const w = world();
  try {
    gmod(w.alice, 'adr', 'propose', JSON.stringify(DRAFT));
    sh(w.alice, 'git', ['switch', '-q', '-c', 'adr-branch']);
    gmod(w.alice, 'adr', 'accept', 'sums-never-round');
    const ok = gmod(w.alice, 'verify', '--base', 'origin/main');
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /✅ a decision record on its own/);
    write(w.alice, { 'src/sum.mjs': CODE });
    sh(w.alice, 'git', ['commit', '-q', '-am', 'and code']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /❌ a decision record travels alone; also changed: src\/sum\.mjs/);
  } finally { w.done(); }
});

test('ADRs: the agent edits ADR files only through drafts', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    assert.match(gmod(w.alice, 'guard-path', 'docs/adr/0001-x.md').out, /decision records change only through a draft a person accepts/);
  } finally { w.done(); }
});

// ---- gap 4: a journal per job ----

test('journal: notes and red/green land in .gmod/journal/<job>.md, without upsetting the commit gate', () => {
  const w = world();
  try {
    gmod(w.alice, 'claim', 'add-sum');
    assert.match(gmod(w.alice, 'note', 'plan: a plain + is enough; no rounding').out, /noted in \.gmod\/journal\/add-sum\.md/);
    write(w.alice, { 'test/sum.test.mjs': TEST });
    gmod(w.alice, 'check');
    write(w.alice, { 'src/sum.mjs': CODE });
    gmod(w.alice, 'check');
    // A note after green doesn't invalidate it.
    gmod(w.alice, 'note', 'done: one line');
    assert.equal(gmod(w.alice, 'gate-commit').code, 0, gmod(w.alice, 'gate-commit').out);
    const j = readFileSync(join(w.alice, '.gmod/journal/add-sum.md'), 'utf8');
    assert.match(j, /^# add-sum: Add two numbers\n/);
    assert.match(j, /\n- \S+ alice@x\.io: plan: a plain \+ is enough; no rounding\n/);
    assert.match(j, /\n- \S+ check: red \(sum adds\)\n/);
    assert.match(j, /\n- \S+ check: green\n/);
    assert.match(j, /\n- \S+ alice@x\.io: done: one line\n$/);
    assert.deepEqual(JSON.parse(gmod(w.alice, 'status', '--no-sync').out).jobs.find(x => x.id === 'add-sum').journal.at(-1).text, 'done: one line');

    // It travels with the job; another job's journal doesn't.
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-sum: sum adds']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /✅ all 3 changed files are within the job/);
    write(w.alice, { '.gmod/journal/add-mul.md': '# add-mul\n' });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '--no-verify', '-m', 'add-sum: and a stray journal']);
    assert.match(gmod(w.alice, 'verify', '--base', 'origin/main').out, /outside the job: \.gmod\/journal\/add-mul\.md/);
  } finally { w.done(); }
});

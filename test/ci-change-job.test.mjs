// A CI change made as a planned job: a job whose files are all CI's own
// (workflows, CODEOWNERS, .gmod/protect.json) lands as a governance change,
// with its journal and a check that needs no test file. CI files still never
// travel with code, and a journal of a job the branch doesn't work is refused.
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
function ident(dir, email) {
  sh(dir, 'git', ['config', 'user.email', email]);
  sh(dir, 'git', ['config', 'user.name', email.split('@')[0]]);
}

const WF = '.github/workflows/gmod.yml';
const OLD = 'name: gmod\njobs:\n  gate:\n    runs-on: ubuntu-latest\n';
const NEW = 'name: gmod\njobs:\n  gate:\n    runs-on: self-hosted\n';
const PLAN = {
  main: 'main',
  checks: {
    sum: 'node test/sum.test.mjs',
    runner: `grep -q "runs-on: self-hosted" ${WF}`,
    runner2: 'node .gmod/checks/runner.mjs',
  },
  jobs: [
    { id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }] },
    // CI alone, no test file: the check reads the workflow.
    { id: 'ci-runner', goal: 'The gate runs on our runner', files: ['.github/workflows/**'], tests: [], done_when: [{ text: 'the gate runs self-hosted', check: 'runner' }] },
    // CI alone, its check a governance check under .gmod/checks/.
    { id: 'ci-runner-checked', goal: 'The gate runs on our runner', files: ['.github/workflows/**', '.gmod/protect.json'], tests: ['.gmod/checks/**'], done_when: [{ text: 'the gate runs self-hosted', check: 'runner2' }] },
    // CI mixed with code: not a governance job.
    { id: 'ci-and-code', goal: 'Workflow and code together', files: ['.github/workflows/**', 'src/**'], tests: [], done_when: [{ text: 'the gate runs self-hosted', check: 'runner' }] },
  ],
};

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-ci-change-job-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(top, 'seed');
  sh(top, 'git', ['clone', '-q', origin, seed]);
  ident(seed, 'owner@x.io');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), [WF]: OLD, 'src/sum.mjs': 'export const sum = () => 0;\n', README: 'x\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  const alice = join(top, 'alice');
  sh(top, 'git', ['clone', '-q', origin, alice]);
  ident(alice, 'alice@x.io');
  return { alice, done: () => rmSync(top, { recursive: true, force: true }) };
}

// gmod's own flow: claim, red, green, gmod commit (not pushed).
function redGreenCommit(dir, id, files = {}) {
  assert.equal(gmod(dir, 'claim', id).code, 0);
  write(dir, files);
  assert.equal(gmod(dir, 'check').code, 1, 'red');
  write(dir, { [WF]: NEW });
  const g = gmod(dir, 'check');
  assert.equal(g.code, 0, g.out + g.err);
  const r = gmod(dir, 'commit', '-m', 'run the gate self-hosted', '--no-push');
  assert.equal(r.code, 0, r.err);
  return sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
}
const verify = (dir, branch) => gmod(dir, 'verify', '--base', 'origin/main', '--branch', branch);

test('a job changing only the workflow passes the gate as a governance change', () => {
  const w = world();
  try {
    assert.deepEqual(redGreenCommit(w.alice, 'ci-runner'), [WF, '.gmod/journal/ci-runner.md']);
    const r = verify(w.alice, 'gmod/ci-runner');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✅ a CI change as job ci-runner/);
    assert.match(r.out, /✅ claimed by alice@x\.io, who made its commits/);
    assert.match(r.out, /✅ the criteria pass with the change \(1\/1\)/);
    assert.match(r.out, /✅ with the code put back .*the criteria fail/);
    assert.match(r.out, /the review checks it weakens nothing that is checked/);
  } finally { w.done(); }
});

test('a CI job may prove itself with a governance check under .gmod/checks/', () => {
  const w = world();
  try {
    const check = "import { readFileSync } from 'node:fs';\nif (!readFileSync('.github/workflows/gmod.yml', 'utf8').includes('runs-on: self-hosted')) process.exit(1);\n";
    const files = redGreenCommit(w.alice, 'ci-runner-checked', { '.gmod/checks/runner.mjs': check });
    assert.deepEqual(files, [WF, '.gmod/checks/runner.mjs', '.gmod/journal/ci-runner-checked.md']);
    const r = verify(w.alice, 'gmod/ci-runner-checked');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✅ a CI change as job ci-runner-checked/);
  } finally { w.done(); }
});

test('a job mixing workflow and code is still refused', () => {
  const w = world();
  try {
    // A job planned with workflow and code is not a CI job.
    redGreenCommit(w.alice, 'ci-and-code', { 'src/sum.mjs': 'export const sum = (a, b) => a + b;\n' });
    const r = verify(w.alice, 'gmod/ci-and-code');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /❌ a CI change carries only CI files; also changed: .*src\/sum\.mjs/);
  } finally { w.done(); }

  const w2 = world();
  try {
    // A CI job's branch that also carries code.
    redGreenCommit(w2.alice, 'ci-runner');
    write(w2.alice, { 'src/sum.mjs': 'export const sum = (a, b) => a + b;\n' });
    sh(w2.alice, 'git', ['commit', '-q', '--no-verify', '-am', 'ci-runner: and some code']);
    const r = verify(w2.alice, 'gmod/ci-runner');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /❌ changes files outside the job: src\/sum\.mjs/);
  } finally { w2.done(); }
});

test("a CI change by a branch that isn't the job's own is refused with its journal", () => {
  const w = world();
  try {
    // Unclaimed: the job is planned, but nobody claimed it.
    write(w.alice, { [WF]: NEW, '.gmod/journal/ci-runner.md': '- did it\n' });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '--no-verify', '-m', 'ci-runner: self-hosted']);
    const r = verify(w.alice, 'gmod/ci-runner');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /❌ nobody claimed ci-runner/);
  } finally { w.done(); }

  const w2 = world();
  try {
    // Unplanned: a branch naming no job carries a job's journal.
    write(w2.alice, { [WF]: NEW, '.gmod/journal/ci-runner.md': '- did it\n' });
    sh(w2.alice, 'git', ['add', '-A']);
    sh(w2.alice, 'git', ['commit', '-q', '--no-verify', '-m', 'self-hosted runner']);
    const r = gmod(w2.alice, 'verify', '--base', 'origin/main', '--branch', 'ci/self-hosted', '--title', 'self-hosted runner');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /❌ a CI change carries only CI files; also changed: \.gmod\/journal\/ci-runner\.md/);
  } finally { w2.done(); }

  const w3 = world();
  try {
    // A CI job's branch carrying the journal of another job.
    redGreenCommit(w3.alice, 'ci-runner');
    write(w3.alice, { '.gmod/journal/add-sum.md': '- not mine\n' });
    sh(w3.alice, 'git', ['add', '-A']);
    sh(w3.alice, 'git', ['commit', '-q', '--no-verify', '-m', 'ci-runner: a stray journal']);
    const r = verify(w3.alice, 'gmod/ci-runner');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /❌ changes files outside the job: \.gmod\/journal\/add-sum\.md/);
  } finally { w3.done(); }
});

test('a CI change on its own, with no job, still passes', () => {
  const w = world();
  try {
    write(w.alice, { [WF]: NEW });
    sh(w.alice, 'git', ['commit', '-q', '--no-verify', '-am', 'self-hosted runner']);
    const r = gmod(w.alice, 'verify', '--base', 'origin/main', '--branch', 'ci/self-hosted', '--title', 'self-hosted runner');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✅ a CI change on its own/);
  } finally { w.done(); }
});

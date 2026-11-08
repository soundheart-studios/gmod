// A job's latest check verdict is shared (ADR 0002): after every check run it
// is published to refs/gmod/runs/<job>, best effort, so a job red on one
// machine is red, and gives its signal, everywhere. Full evidence stays local.
// The verdict is a signal, never proof: the gate never reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
const TEST = "import { sum } from '../src/sum.mjs';\nif (sum(2, 3) !== 5) process.exit(1);\n";
const CODE = 'export const sum = (a, b) => a + b;\n';

function clone(top, origin, name) {
  const dir = join(top, name);
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', `${name}@x.io`]);
  sh(dir, 'git', ['config', 'user.name', name]);
  return dir;
}

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-shared-runs-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = clone(top, origin, 'owner');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n', README: 'x\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { top, origin, seed, alice: clone(top, origin, 'alice'), bob: clone(top, origin, 'bob'), done: () => rmSync(top, { recursive: true, force: true }) };
}
const onOrigin = w => spawnSync('git', ['--git-dir', w.origin, 'rev-parse', '-q', '--verify', 'refs/gmod/runs/add-sum'], { env: ENV }).status === 0;

test('a job left red in one clone gives its unstick signal in another clone', () => {
  const w = world();
  try {
    assert.equal(gmod(w.alice, 'claim', 'add-sum').code, 0);
    write(w.alice, { 'test/sum.test.mjs': TEST });
    assert.match(gmod(w.alice, 'check').out, /red/);
    assert.ok(onOrigin(w), 'the verdict is published to refs/gmod/runs/add-sum');

    const { signals } = JSON.parse(gmod(w.bob, 'signals', '--json').out);
    const stuck = signals.find(s => s.cause?.stuck === 'add-sum');
    assert.ok(stuck, `bob sees add-sum red: ${JSON.stringify(signals)}`);
    assert.equal(stuck.kind, 'unstick');
    assert.match(stuck.detail ?? '', /✗ sum adds/);
    const job = JSON.parse(gmod(w.bob, 'state', '--json').out).jobs.find(j => j.id === 'add-sum');
    assert.equal(job.state, 'stuck');

    // Green there: no longer stuck here.
    write(w.alice, { 'src/sum.mjs': CODE });
    assert.match(gmod(w.alice, 'check').out, /green/);
    const after = JSON.parse(gmod(w.bob, 'signals', '--json').out).signals;
    assert.ok(!after.some(s => s.cause?.stuck === 'add-sum'), 'green elsewhere clears it');
  } finally { w.done(); }
});

test('a check run still records and passes with no remote or a failing push', () => {
  const w = world();
  try {
    // No remote at all.
    const lone = join(w.top, 'lone');
    sh(w.top, 'git', ['clone', '-q', w.origin, lone]);
    sh(lone, 'git', ['config', 'user.email', 'lone@x.io']);
    sh(lone, 'git', ['remote', 'remove', 'origin']);
    assert.equal(gmod(lone, 'claim', 'add-sum', '--no-branch').code, 0);
    write(lone, { 'test/sum.test.mjs': TEST, 'src/sum.mjs': CODE });
    const a = gmod(lone, 'check');
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /green/);

    // A remote that can't be reached by the time the check runs.
    assert.equal(gmod(w.alice, 'claim', 'add-sum').code, 0);
    sh(w.alice, 'git', ['remote', 'set-url', 'origin', join(w.top, 'gone.git')]);
    write(w.alice, { 'test/sum.test.mjs': TEST, 'src/sum.mjs': CODE });
    const b = gmod(w.alice, 'check');
    assert.equal(b.code, 0, b.err);
    assert.match(b.out, /green/);
    const evidence = JSON.parse(readFileSync(join(w.alice, '.git', 'gmod', 'evidence', 'add-sum.json'), 'utf8'));
    assert.equal(evidence.at(-1).result, 'green', 'the run is recorded locally');
  } finally { w.done(); }
});

test('sweep removes the runs ref of a job done on main', () => {
  const w = world();
  try {
    assert.equal(gmod(w.alice, 'claim', 'add-sum').code, 0);
    write(w.alice, { 'test/sum.test.mjs': TEST, 'src/sum.mjs': CODE });
    gmod(w.alice, 'check');
    assert.ok(onOrigin(w));
    // It lands on main.
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-sum: sum adds']);
    sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    // CI sweeps on main as merged.
    sh(w.seed, 'git', ['pull', '-q', 'origin', 'main']);
    assert.equal(gmod(w.seed, 'sweep').code, 0);
    assert.ok(!onOrigin(w), 'gone from origin');
    gmod(w.bob, 'signals', '--json');
    assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/gmod/runs/add-sum'], { cwd: w.bob, env: ENV }).status, 1, 'and from other clones once they sync');
  } finally { w.done(); }
});

test('gmod verify gives the same verdict with a forged green runs ref', () => {
  const w = world();
  try {
    assert.equal(gmod(w.alice, 'claim', 'add-sum').code, 0);
    // A test that passes whatever the code does: the gate must fail it.
    write(w.alice, { 'src/sum.mjs': CODE, 'test/sum.test.mjs': 'process.exit(0);\n' });
    sh(w.alice, 'git', ['add', '-A']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'add-sum: weak test']);
    const without = gmod(w.alice, 'verify', '--base', 'origin/main', '--branch', 'gmod/add-sum');

    // A green verdict, published and fetched.
    assert.match(gmod(w.alice, 'check').out, /green/);
    assert.ok(onOrigin(w));
    sh(w.alice, 'git', ['fetch', '-q', 'origin', '+refs/gmod/*:refs/gmod/*']);
    const withGreen = gmod(w.alice, 'verify', '--base', 'origin/main', '--branch', 'gmod/add-sum');

    assert.notEqual(without.code, 0, 'the weak test fails the gate');
    assert.equal(withGreen.code, without.code);
    assert.equal(withGreen.out, without.out);
  } finally { w.done(); }
});

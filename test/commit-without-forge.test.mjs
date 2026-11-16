// gmod commit in a repository whose origin is a plain path (no GitHub, GitLab
// or Gitea): it commits and pushes, then says the branch is ready and that no
// pull request was opened, and exits 0. gmod pr on its own still errors.
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

const PLAN = {
  main: 'main',
  checks: { sum: 'node test/sum.test.mjs' },
  jobs: [{ id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }] }],
};
const TEST = "import { sum } from '../src/sum.mjs';\nif (sum(2, 3) !== 5) process.exit(1);\n";

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-no-forge-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(top, 'seed');
  sh(top, 'git', ['clone', '-q', origin, seed]);
  ident(seed, 'owner@x.io');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n', README: 'x\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  const alice = join(top, 'alice');
  sh(top, 'git', ['clone', '-q', origin, alice]);
  ident(alice, 'alice@x.io');
  return { alice, origin, done: () => rmSync(top, { recursive: true, force: true }) };
}

test('gmod commit with a local-path origin pushes and says the branch is ready', () => {
  const w = world();
  try {
    const dir = w.alice;
    assert.equal(gmod(dir, 'claim', 'add-sum').code, 0);
    write(dir, { 'test/sum.test.mjs': TEST });
    assert.equal(gmod(dir, 'check').code, 1, 'red');
    write(dir, { 'src/sum.mjs': 'export const sum = (a, b) => a + b;\n' });
    assert.equal(gmod(dir, 'check').code, 0, 'green');
    const r = gmod(dir, 'commit', '-m', 'sum adds');
    assert.equal(r.code, 0, `exit 0, got ${r.code}: ${r.err}`);
    assert.match(r.out, /pushed gmod\/add-sum/);
    assert.match(r.out, /add-sum: committed and pushed gmod\/add-sum; origin is no forge gmod knows, so no pull request was opened: the branch is ready/);
    assert.doesNotMatch(r.err, /can't read the forge/);
    // The branch really is on origin, with the job's commit.
    const subject = sh(w.origin, 'git', ['log', '-1', '--format=%s', 'gmod/add-sum']);
    assert.match(subject, /^add-sum: sum adds/);
  } finally { w.done(); }
});

test('gmod pr on its own keeps its error for a local-path origin', () => {
  const w = world();
  try {
    const r = gmod(w.alice, 'pr', '--job', 'add-sum', '--branch', 'gmod/add-sum');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /can't read the forge from origin/);
  } finally { w.done(); }
});

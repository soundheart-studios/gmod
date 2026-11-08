// gmod commit holds the job's own files: what changed within its files and
// tests, and its journal. Never a repository nested in the worktree, never a
// stray file outside the job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
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
const CODE = 'export const sum = (a, b) => a + b;\n';

// A bare origin and alice's clone of it, the plan and some code on main.
function world(extra = {}) {
  const top = mkdtempSync(join(tmpdir(), 'gmod-commit-files-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(top, 'seed');
  sh(top, 'git', ['clone', '-q', origin, seed]);
  ident(seed, 'owner@x.io');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n', README: 'x\n', ...extra });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  const alice = join(top, 'alice');
  sh(top, 'git', ['clone', '-q', origin, alice]);
  ident(alice, 'alice@x.io');
  return { alice, done: () => rmSync(top, { recursive: true, force: true }) };
}

// Red, then green, then gmod commit (not pushed): the files of the commit made.
function redGreenCommit(dir, more = () => {}) {
  assert.equal(gmod(dir, 'claim', 'add-sum').code, 0);
  write(dir, { 'src/sum.mjs': 'export const sum = () => 0;\n', 'test/sum.test.mjs': TEST });
  more();
  assert.equal(gmod(dir, 'check').code, 1, 'red');
  write(dir, { 'src/sum.mjs': CODE });
  assert.equal(gmod(dir, 'check').code, 0, 'green');
  const r = gmod(dir, 'commit', '-m', 'sum adds', '--no-push');
  assert.equal(r.code, 0, r.err);
  return sh(dir, 'git', ['show', '--name-status', '--no-renames', '--format=', 'HEAD']).split('\n').filter(Boolean);
}

function nestedRepo(dir) {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  ident(dir, 'agent@x.io');
  writeFileSync(join(dir, 'f.txt'), 'nested\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'nested work']);
}

test('a nested git repository in the worktree is not committed, even within the job', () => {
  const w = world();
  try {
    const files = redGreenCommit(w.alice, () => {
      nestedRepo(join(w.alice, '.claude', 'worktrees', 'agent'));
      nestedRepo(join(w.alice, 'src', 'vendor'));
    });
    assert.deepEqual(files.sort(), ['A\t.gmod/journal/add-sum.md', 'A\ttest/sum.test.mjs', 'M\tsrc/sum.mjs']);
    const tree = sh(w.alice, 'git', ['ls-tree', '-r', 'HEAD']);
    assert.doesNotMatch(tree, /^160000 /m, 'no gitlink');
    assert.doesNotMatch(tree, /worktrees|vendor/);
  } finally { w.done(); }
});

test('an untracked file outside the job is not committed, and stays where it is', () => {
  const w = world();
  try {
    const files = redGreenCommit(w.alice, () => write(w.alice, { 'stray.txt': 'stray\n', 'notes/todo.md': '- x\n', README: 'changed outside\n' }));
    assert.deepEqual(files.sort(), ['A\t.gmod/journal/add-sum.md', 'A\ttest/sum.test.mjs', 'M\tsrc/sum.mjs']);
    assert.deepEqual(sh(w.alice, 'git', ['ls-files', '--others', '--exclude-standard']).split('\n'), ['notes/todo.md', 'stray.txt']);
    assert.equal(sh(w.alice, 'git', ['diff', '--name-only', 'HEAD']), 'README');
  } finally { w.done(); }
});

test('a file deleted or renamed inside the job is still committed', () => {
  const w = world({ 'src/old.mjs': 'export const old = 1;\n', 'src/gone.mjs': 'export const gone = 1;\n' });
  try {
    const files = redGreenCommit(w.alice, () => {
      renameSync(join(w.alice, 'src/old.mjs'), join(w.alice, 'src/new.mjs'));
      rmSync(join(w.alice, 'src/gone.mjs'));
    });
    assert.deepEqual(files.sort(), [
      'A\t.gmod/journal/add-sum.md', 'A\tsrc/new.mjs', 'A\ttest/sum.test.mjs',
      'D\tsrc/gone.mjs', 'D\tsrc/old.mjs', 'M\tsrc/sum.mjs',
    ]);
    assert.equal(sh(w.alice, 'git', ['status', '--porcelain']), '');
  } finally { w.done(); }
});

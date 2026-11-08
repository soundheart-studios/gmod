// Managed mode: a per-repository switch, off by default, turned on or off only
// by a person, as a decision commit of its own (ADR 0001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function world({ email = 'alice@x.io', name = 'alice' } = {}) {
  const top = mkdtempSync(join(tmpdir(), 'gmod-managed-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const alice = join(top, 'alice');
  sh(top, 'git', ['clone', '-q', origin, alice]);
  sh(alice, 'git', ['config', 'user.email', email]);
  sh(alice, 'git', ['config', 'user.name', name]);
  write(alice, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n', 'README': 'x\n' });
  sh(alice, 'git', ['add', '-A']);
  sh(alice, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { alice, done: () => rmSync(top, { recursive: true, force: true }) };
}

const state = dir => JSON.parse(gmod(dir, 'state', '--json', '--no-sync').out);

test('managed mode is off by default: no file, manage says off, state says managed: false', () => {
  const w = world();
  try {
    assert.equal(existsSync(join(w.alice, '.gmod/managed.json')), false);
    const r = gmod(w.alice, 'manage');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /managed mode is off/);
    assert.equal(JSON.parse(gmod(w.alice, 'manage', '--json').out).managed, false);
    assert.equal(JSON.parse(gmod(w.alice, 'manage', 'status', '--json').out).managed, false);
    assert.equal(state(w.alice).managed, false);
    // Reading it writes nothing.
    assert.equal(sh(w.alice, 'git', ['status', '--porcelain']), '');
  } finally { w.done(); }
});

test('gmod manage on writes .gmod/managed.json as a decision commit, alone, and state says managed: true', () => {
  const w = world();
  try {
    write(w.alice, { 'README': 'work in progress\n' });
    const before = sh(w.alice, 'git', ['rev-parse', 'HEAD']);
    const on = gmod(w.alice, 'manage', 'on');
    assert.equal(on.code, 0, on.err);
    assert.match(on.out, /managed mode on/);
    assert.deepEqual(JSON.parse(readFileSync(join(w.alice, '.gmod/managed.json'), 'utf8')), { v: 1, managed: true });
    assert.equal(sh(w.alice, 'git', ['rev-parse', 'HEAD^']), before);
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s']), 'managed: on');
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%ae']), 'alice@x.io');
    assert.equal(sh(w.alice, 'git', ['show', '--name-only', '--format=', 'HEAD']), '.gmod/managed.json', 'the switch travels alone');
    assert.equal(sh(w.alice, 'git', ['status', '--short']), 'M README', 'other work stays uncommitted');
    assert.equal(state(w.alice).managed, true);
    assert.equal(JSON.parse(gmod(w.alice, 'manage', '--json').out).managed, true);

    // Already on: nothing to decide, no new commit.
    const again = gmod(w.alice, 'manage', 'on');
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already on/);
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s']), 'managed: on');

    // And off again, the same way.
    const off = gmod(w.alice, 'manage', 'off');
    assert.equal(off.code, 0, off.err);
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s']), 'managed: off');
    assert.deepEqual(JSON.parse(readFileSync(join(w.alice, '.gmod/managed.json'), 'utf8')), { v: 1, managed: false });
    assert.equal(state(w.alice).managed, false);
  } finally { w.done(); }
});

test("gmod manage on from a job's branch commits on main's tip and leaves the job as it was", () => {
  const w = world();
  try {
    const main = sh(w.alice, 'git', ['rev-parse', 'main']);
    assert.equal(gmod(w.alice, 'claim', 'add-sum').code, 0);
    write(w.alice, { 'src/sum.mjs': 'export const sum = (a, b) => a + b;\n' });
    const head = sh(w.alice, 'git', ['rev-parse', 'HEAD']);
    const status = sh(w.alice, 'git', ['status', '--porcelain']);

    const on = gmod(w.alice, 'manage', 'on');
    assert.equal(on.code, 0, on.err);
    const branch = on.out.match(/on (gmod\/managed-on-\w+)/)?.[1];
    assert.ok(branch, on.out);
    const commit = sh(w.alice, 'git', ['rev-parse', branch]);
    assert.equal(sh(w.alice, 'git', ['rev-parse', `${commit}^`]), main, "built on main's tip");
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s', commit]), 'managed: on');
    assert.equal(sh(w.alice, 'git', ['show', '--name-only', '--format=', commit]), '.gmod/managed.json');
    assert.equal(sh(w.alice, 'git', ['rev-parse', 'main']), commit);

    assert.equal(sh(w.alice, 'git', ['branch', '--show-current']), 'gmod/add-sum');
    assert.equal(sh(w.alice, 'git', ['rev-parse', 'HEAD']), head);
    assert.equal(sh(w.alice, 'git', ['status', '--porcelain']), status);
    assert.equal(existsSync(join(w.alice, '.gmod/managed.json')), false, "the job's checkout doesn't gain the file");
  } finally { w.done(); }
});

test('an agent identity is refused: only a person switches managed mode', () => {
  const w = world({ email: 'gmod-agent@users.noreply.github.com', name: 'gmod agent' });
  try {
    for (const how of ['on', 'off']) {
      const r = gmod(w.alice, 'manage', how);
      assert.equal(r.code, 1);
      assert.match(r.err, /only a person/);
    }
    assert.equal(existsSync(join(w.alice, '.gmod/managed.json')), false);
    assert.equal(sh(w.alice, 'git', ['log', '-1', '--format=%s']), 'seed the plan');
    // Reading it is fine.
    assert.equal(gmod(w.alice, 'manage').code, 0);
  } finally { w.done(); }
});

test('a bad argument is refused and changes nothing', () => {
  const w = world();
  try {
    const r = gmod(w.alice, 'manage', 'maybe');
    assert.equal(r.code, 1);
    assert.match(r.err, /gmod manage/);
    assert.equal(existsSync(join(w.alice, '.gmod/managed.json')), false);
  } finally { w.done(); }
});

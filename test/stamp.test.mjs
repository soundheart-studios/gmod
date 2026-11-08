// The change stamp: one cheap value every surface can watch or poll, that
// moves whenever anything state or signals show may have changed. Its counter
// lives in <git-common-dir>/gmod/stamp, rewritten on every gmod write a
// signal or state depends on; its hash covers the tips of main and
// refs/gmod/*, so a plain git fetch moves it too. Reading never moves it.
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
  assert.equal(r.status, 0, `gmod ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const stamp = dir => gmod(dir, 'stamp');

const PLAN = {
  main: 'main',
  checks: { ok: 'true' },
  jobs: [{ id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'ok' }] }],
};
const NEG = { id: 'add-neg', goal: 'Negate', files: ['src/neg.mjs'], tests: ['test/neg.test.mjs'], done_when: [{ text: 'neg negates', check: 'ok' }] };

function clone(top, origin, name) {
  const dir = join(top, name);
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', `${name}@x.io`]);
  sh(dir, 'git', ['config', 'user.name', name]);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-stamp-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const alice = clone(top, origin, 'alice');
  mkdirSync(join(alice, '.gmod'));
  writeFileSync(join(alice, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  sh(alice, 'git', ['add', '-A']);
  sh(alice, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { top, origin, alice, done: () => rmSync(top, { recursive: true, force: true }) };
}

test('drafting a job, recording a check run, and claiming each change gmod stamp; reading state or signals does not', () => {
  const w = world();
  try {
    const file = join(w.alice, '.git', 'gmod', 'stamp');
    const s0 = stamp(w.alice);
    assert.match(s0, /^\d+-[0-9a-f]{8}$/, 'counter-hash');

    gmod(w.alice, 'propose-job', JSON.stringify(NEG));
    const s1 = stamp(w.alice);
    assert.notEqual(s1, s0, 'drafting moves it');
    const counter = readFileSync(file, 'utf8');

    gmod(w.alice, 'state', '--json');
    gmod(w.alice, 'signals', '--json');
    gmod(w.alice, 'proposal', '--json');
    assert.equal(stamp(w.alice), s1, 'reading does not move it');
    assert.equal(readFileSync(file, 'utf8'), counter, 'reading does not rewrite the file');

    gmod(w.alice, 'claim', 'add-sum');
    const s2 = stamp(w.alice);
    assert.notEqual(s2, s1, 'claiming moves it');
    assert.notEqual(readFileSync(file, 'utf8'), counter, 'claiming rewrites the file watchers watch');

    gmod(w.alice, 'check');
    const s3 = stamp(w.alice);
    assert.notEqual(s3, s2, 'a check run moves it');
  } finally { w.done(); }
});

test('a fetch that moves refs/gmod/* or origin\'s main changes the stamp without gmod writing', () => {
  const w = world();
  try {
    const bob = clone(w.top, w.origin, 'bob');
    const before = stamp(bob);
    gmod(w.alice, 'claim', 'add-sum', '--no-branch');
    sh(bob, 'git', ['fetch', '-q', 'origin', '+refs/gmod/*:refs/gmod/*']);
    const afterClaim = stamp(bob);
    assert.notEqual(afterClaim, before, 'a claim fetched by plain git moves it');

    writeFileSync(join(w.alice, 'README'), 'x\n');
    sh(w.alice, 'git', ['add', 'README']);
    sh(w.alice, 'git', ['commit', '-q', '-m', 'readme', '--', 'README']);
    sh(w.alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
    sh(bob, 'git', ['fetch', '-q', 'origin']);
    assert.notEqual(stamp(bob), afterClaim, "origin's main moving moves it");
  } finally { w.done(); }
});

test('state --json and signals --json carry the same stamp gmod stamp prints, and capabilities lists stamp', () => {
  const w = world();
  try {
    gmod(w.alice, 'propose-job', JSON.stringify(NEG));
    const s = stamp(w.alice);
    assert.equal(JSON.parse(gmod(w.alice, 'state', '--json', '--no-sync')).stamp, s);
    assert.equal(JSON.parse(gmod(w.alice, 'signals', '--json', '--no-sync')).stamp, s);
    assert.equal(JSON.parse(gmod(w.alice, 'stamp', '--json')).stamp, s);
    assert.ok(JSON.parse(gmod(w.alice, 'capabilities', '--json')).commands.includes('stamp'));
  } finally { w.done(); }
});

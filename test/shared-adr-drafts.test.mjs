// ADR drafts are shared (ADR 0002): each lives at refs/gmod/adr-drafts/<slug>,
// pushed to origin like claims, one ref per draft so drafts never contend.
// Accepting or rejecting removes it everywhere. A 1.6 adr-drafts.json is
// carried over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function ok(cwd, ...args) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `gmod ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'add-sum', goal: 'Sum', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sums', check: 'ok' }] }] };
const draft = title => ({ title, scope: ['src/**'], context: 'Why.', decision: `We decided ${title}.`, rules: [{ level: 'must', text: `keep ${title}` }] });
const slug = title => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function clone(top, origin, name) {
  const dir = join(top, name);
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', `${name}@x.io`]);
  sh(dir, 'git', ['config', 'user.name', name]);
  return dir;
}

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-shared-adr-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const alice = clone(top, origin, 'alice');
  mkdirSync(join(alice, '.gmod'));
  writeFileSync(join(alice, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  sh(alice, 'git', ['add', '-A']);
  sh(alice, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(alice, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  const bob = clone(top, origin, 'bob');
  return { top, origin, alice, bob, done: () => rmSync(top, { recursive: true, force: true }) };
}

// The drafts this clone lists, after a read that syncs (signals).
function listed(dir) {
  ok(dir, 'signals', '--json');
  return JSON.parse(ok(dir, 'adr', 'drafts', '--json')).map(d => d.draft).sort();
}
const onOrigin = (w, s) => spawnSync('git', ['--git-dir', w.origin, 'rev-parse', '-q', '--verify', `refs/gmod/adr-drafts/${s}`], { env: ENV }).status === 0;

test('an ADR drafted in one clone is listed by gmod adr drafts in another', () => {
  const w = world();
  try {
    ok(w.alice, 'adr', 'propose', JSON.stringify(draft('Sums never round')));
    assert.ok(onOrigin(w, 'sums-never-round'), 'pushed to refs/gmod/adr-drafts/<slug>');
    ok(w.bob, 'adr', 'propose', JSON.stringify(draft('Money is integer cents')));
    assert.deepEqual(listed(w.bob), ['money-is-integer-cents', 'sums-never-round']);
    assert.deepEqual(listed(w.alice), ['money-is-integer-cents', 'sums-never-round']);
    const d = JSON.parse(ok(w.bob, 'adr', 'drafts', '--json')).find(x => x.draft === 'sums-never-round');
    assert.equal(d.decision, 'We decided Sums never round.');
    assert.equal(d.by, 'alice@x.io');
  } finally { w.done(); }
});

test('accepting or rejecting in one clone removes the draft everywhere', () => {
  const w = world();
  try {
    ok(w.alice, 'adr', 'propose', JSON.stringify(draft('Sums never round')));
    ok(w.alice, 'adr', 'propose', JSON.stringify(draft('Money is integer cents')));
    assert.deepEqual(listed(w.bob), ['money-is-integer-cents', 'sums-never-round']);

    ok(w.bob, 'adr', 'accept', slug('Sums never round'), '--no-pr');
    assert.ok(!onOrigin(w, 'sums-never-round'), 'accepted: gone from origin');
    assert.ok(existsSync(join(w.bob, 'docs', 'adr', '0001-sums-never-round.md')), 'and written as ADR 0001');
    assert.deepEqual(listed(w.alice), ['money-is-integer-cents']);

    ok(w.alice, 'adr', 'reject', slug('Money is integer cents'), 'not now');
    assert.ok(!onOrigin(w, 'money-is-integer-cents'), 'rejected: gone from origin');
    assert.deepEqual(listed(w.bob), []);
  } finally { w.done(); }
});

test('a 1.6 adr-drafts.json is carried over to refs', () => {
  const w = world();
  try {
    const legacy = join(w.alice, '.git', 'gmod', 'adr-drafts.json');
    mkdirSync(dirname(legacy), { recursive: true });
    const old = { draft: 'old-decision', ...draft('Old decision'), supersedes: null, by: 'alice@x.io', at: '2026-11-01T00:00:00.000Z' };
    writeFileSync(legacy, JSON.stringify([old], null, 2));
    assert.deepEqual(listed(w.alice), ['old-decision']);
    assert.ok(!existsSync(legacy), 'the old file is gone once carried over');
    assert.ok(onOrigin(w, 'old-decision'), 'and pushed');
    assert.deepEqual(listed(w.bob), ['old-decision']);
  } finally { w.done(); }
});

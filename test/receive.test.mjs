// Gap 5: claims guarded on the server. The origin gets Gitea's hook layout
// (pre-receive runs every script in pre-receive.d), and the pusher is told
// to the hook as Gitea tells it: GITEA_PUSHER_EMAIL and GITEA_PUSHER_NAME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'add-sum', goal: 'Add', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'adds', check: 'ok' }] }] };

const sh = (cwd, args, env = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, ...env } });
const gmod = (cwd, args, env = {}) => spawnSync('node', [GMOD, ...args], { cwd, encoding: 'utf8', env: { ...ENV, ...env } });
const as = (email, name = email.split('@')[0]) => ({ GITEA_PUSHER_EMAIL: email, GITEA_PUSHER_NAME: name });

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-receive-'));
  const origin = join(top, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const clone = (name, email) => {
    const dir = join(top, name);
    execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'config', 'user.email', email]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', name]);
    return dir;
  };
  const seed = clone('seed', 'owner@x.io');
  mkdirSync(join(seed, '.gmod'));
  writeFileSync(join(seed, '.gmod', 'plan.json'), JSON.stringify(PLAN));
  execFileSync('git', ['-C', seed, 'add', '-A']);
  execFileSync('git', ['-C', seed, 'commit', '-q', '-m', 'seed']);
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'HEAD:main']);
  writeFileSync(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\ndata=$(cat)\nfor h in "$(dirname "$0")"/pre-receive.d/*; do [ -x "$h" ] || continue; echo "$data" | "$h" || exit 1; done\n', { mode: 0o755 });
  return { top, origin, alice: clone('alice', 'alice@x.io'), bob: clone('bob', 'bob@x.io'), done: () => rmSync(top, { recursive: true, force: true }) };
}

test('claim guard: create freely, never move, delete only your own (or as an admin)', () => {
  const w = world();
  try {
    const installed = gmod(w.alice, ['ci', 'guard-claims', '--repo-path', w.origin, '--admins', 'gitea-actions']);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /guarding claims in .*origin\.git/);

    // alice claims: a new claim is fine.
    const c = gmod(w.alice, ['claim', 'add-sum', '--no-branch'], as('alice@x.io'));
    assert.equal(c.status, 0, c.stderr);

    // bob can't let it go, or point it elsewhere.
    const ref = 'refs/gmod/claims/add-sum';
    sh(w.bob, ['fetch', '-q', 'origin', `+${ref}:${ref}`]);
    let r = sh(w.bob, ['push', 'origin', `:${ref}`], as('bob@x.io'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /gmod: add-sum is claimed by alice@x\.io: only they, or an admin, let it go/);
    const other = sh(w.bob, ['commit-tree', EMPTY_TREE, '-m', '{"job":"add-sum","by":"bob@x.io"}']).stdout.trim();
    r = sh(w.bob, ['push', '--force', 'origin', `${other}:${ref}`], as('bob@x.io'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /gmod: claims don't move: release add-sum and claim it again/);

    // An admin (the CI bot sweeping finished jobs) may let it go.
    r = sh(w.bob, ['push', 'origin', `:${ref}`], as('x@y', 'gitea-actions'));
    assert.equal(r.status, 0, r.stderr);

    // alice releases her own.
    gmod(w.alice, ['release'], as('alice@x.io'));
    assert.equal(gmod(w.alice, ['claim', 'add-sum', '--no-branch'], as('alice@x.io')).status, 0);
    const rel = gmod(w.alice, ['release'], as('alice@x.io'));
    assert.equal(rel.status, 0, rel.stderr);
    assert.equal(sh(w.alice, ['ls-remote', 'origin', 'refs/gmod/claims/*']).stdout.trim(), '');

    // Branches are none of its business.
    r = sh(w.bob, ['push', 'origin', 'HEAD:refs/heads/anything'], as('bob@x.io'));
    assert.equal(r.status, 0, r.stderr);
  } finally { w.done(); }
});

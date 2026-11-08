// gmod capabilities --json: which gmod this is, the protocol it speaks and
// what it enforces, as a face like Skiff asks before reading anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GMOD = join(ROOT, 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// The enforcer kinds Skiff knows (DESIGN 11.3); anything else it shows as unknown.
const KINDS = ['engine', 'mod', 'gate', 'forge', 'check', 'review', 'person'];

function gmod(cwd, ...args) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('capabilities --json prints the version, protocol 1.x and the enforcers', () => {
  // Like `gmod version`, it needs no repository.
  const dir = mkdtempSync(join(tmpdir(), 'gmod-caps-'));
  try {
    const r = gmod(dir, 'capabilities', '--json');
    assert.equal(r.code, 0, r.err);
    const c = JSON.parse(r.out);
    assert.equal(c.v, 1);
    assert.equal(c.engine, 'gmod');
    assert.equal(c.version, version);
    assert.match(c.protocol, /^1\.\d+$/);

    // Skiff reads enforcers as kind names.
    assert.ok(Array.isArray(c.enforcers) && c.enforcers.length > 0);
    for (const k of c.enforcers) assert.ok(KINDS.includes(k), `unknown enforcer kind ${k}`);
    for (const k of ['mod', 'gate', 'review', 'check', 'forge', 'engine', 'person']) assert.ok(c.enforcers.includes(k), `missing ${k}`);
    assert.equal(new Set(c.enforcers).size, c.enforcers.length);

    // What each one holds, and where: every kind listed holds something, and
    // nothing is held by a kind that isn't listed.
    assert.ok(Array.isArray(c.enforces));
    for (const e of c.enforces) {
      assert.ok(c.enforcers.includes(e.kind), `${e.kind} holds a rule but isn't listed`);
      assert.ok(e.what && e.where, JSON.stringify(e));
    }
    for (const k of c.enforcers) assert.ok(c.enforces.some(e => e.kind === k), `${k} holds nothing`);

    // The commands a face may call.
    for (const cmd of ['capabilities', 'state', 'signals']) assert.ok(c.commands.includes(cmd), cmd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capabilities without --json says the same in words', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-caps-'));
  try {
    const r = gmod(dir, 'capabilities');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`gmod ${version.replace(/\./g, '\\.')}`));
    assert.match(r.out, /protocol 1\.\d+/);
    assert.match(r.out, /\bgate\b/);
    assert.match(gmod(dir, 'help').out, /gmod capabilities/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

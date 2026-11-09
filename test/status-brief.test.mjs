// gmod status --brief: what an agent needs from status (mcp__gmod__status),
// without the plan's history. The full status carries every ADR's text in
// every job it covers and each job's journal; on a long plan that is ~200 KB.
// The brief keeps the claim in full, lists done jobs by id, gives unfinished
// jobs ADR ids instead of text, and lists each cited ADR once.
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
const adr = (id, title, scope, rule) => `---
id: ${id}
title: ${title}
status: accepted
scope: ${scope}
date: 2026-11-09
---

## Context

Some context.

## Decision

Some decision.

## Rules
- must: ${rule}
`;

const job = (id, phase, after = []) => ({ id, goal: `The ${id} part`, brief: `All about ${id}.`, files: [`src/${id}.mjs`], tests: [`test/${id}.test.mjs`], done_when: [{ text: `${id} works`, check: 'ok' }], phase, after });
const PLAN = {
  main: 'main',
  checks: { ok: 'true' },
  phases: [
    { id: 'build', title: 'Build it', outcome: 'It is built' },
    { id: 'ship', title: 'Ship it', outcome: 'It is shipped', after: ['build'] },
  ],
  jobs: [job('one', 'build'), job('two', 'build'), job('three', 'build'), job('four', 'ship')],
};

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-brief-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(top, 'seed');
  sh(top, 'git', ['clone', '-q', origin, seed]);
  sh(seed, 'git', ['config', 'user.email', 'owner@x.io']);
  sh(seed, 'git', ['config', 'user.name', 'owner']);
  write(seed, {
    '.gmod/plan.json': JSON.stringify(PLAN, null, 2),
    'docs/adr/0001-everything.md': adr('0001', 'Everything is tested', 'src/**', 'Every module has a test'),
    'docs/adr/0002-two-only.md': adr('0002', 'Two stays pure', 'src/two.mjs', 'two has no side effects'),
    README: 'x\n',
  });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  write(seed, { 'src/one.mjs': 'export const one = 1;\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'one: the one part']);
  sh(seed, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { top, seed, done: () => rmSync(top, { recursive: true, force: true }) };
}

const json = r => { assert.equal(r.code, 0, r.err); return JSON.parse(r.out); };

test('status --brief: the claim in full, done jobs by id, open jobs without ADR text, each ADR once', () => {
  const w = world();
  try {
    assert.equal(gmod(w.seed, 'claim', 'two').code, 0);
    const full = json(gmod(w.seed, 'status', '--no-sync'));
    const brief = json(gmod(w.seed, 'status', '--no-sync', '--brief'));

    // The full status is what it was: every job, each with its ADRs' text.
    assert.equal(full.jobs.length, 4);
    assert.ok(full.jobs.every(j => Array.isArray(j.adrs) && j.adrs.every(a => Array.isArray(a.rules))));

    // The claim, evidence, gate, next, requests and proposal are as in full.
    for (const k of ['governed', 'claim', 'evidence', 'sawRed', 'gate', 'next', 'requests', 'resolved', 'proposal', 'adrDrafts']) {
      assert.deepEqual(brief[k], full[k], k);
    }
    assert.equal(brief.claim.job, 'two');
    assert.deepEqual(brief.claim.adrs.map(a => a.id).sort(), ['0001', '0002']);
    assert.ok(brief.claim.adrs.every(a => a.rules.length), 'the claim keeps its ADRs in full');

    // Done jobs by id only; the open ones without ADR text.
    assert.deepEqual(brief.done, ['one']);
    assert.deepEqual(brief.jobs.map(j => j.id), ['two', 'three', 'four']);
    for (const j of brief.jobs) {
      assert.ok(j.adrs.every(a => typeof a === 'string'), `${j.id}: ADR ids, not text`);
      assert.ok(!('journal' in j) || j.journal.length <= 3, `${j.id}: a short journal`);
      assert.equal(typeof j.state, 'string');
      assert.equal(typeof j.goal, 'string');
    }
    assert.deepEqual(brief.jobs.find(j => j.id === 'two').adrs.sort(), ['0001', '0002']);

    // Each cited ADR once, by id and title.
    assert.deepEqual(brief.adrs, [{ id: '0001', title: 'Everything is tested' }, { id: '0002', title: 'Two stays pure' }]);

    // Phases, short.
    assert.deepEqual(brief.phases.map(p => Object.keys(p).sort()), brief.phases.map(() => ['done', 'id', 'state', 'title', 'total', 'waiting']));
    assert.deepEqual(brief.phases.map(p => [p.id, p.done, p.total]), [['build', 1, 3], ['ship', 0, 1]]);

    assert.ok(JSON.stringify(brief).length < JSON.stringify(full).length);
  } finally {
    w.done();
  }
});

test('status --brief without a plan says so, as full status does', () => {
  const top = mkdtempSync(join(tmpdir(), 'gmod-brief-none-'));
  try {
    sh(top, 'git', ['init', '-q', '-b', 'main']);
    const brief = json(gmod(top, 'status', '--no-sync', '--brief'));
    assert.equal(brief.governed, false);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

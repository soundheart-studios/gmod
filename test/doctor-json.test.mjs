// gmod doctor --json reports what is actually set up (Skiff's Govern, its
// DESIGN.md §6.4): one check each for the plan, managed mode, the workflow
// and its gmod pin, the runner, the reviewer, main's protection and the
// installed gmod, each ok, missing or differs, with a one-line fix. No
// network: the same fake ssh and gh as setup-runs-on.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionWorkflow, doctor } from '../lib/setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let tmp;
const saved = {};
const ENV = ['GMOD_GH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'FAKE_GH_LOG', 'FAKE_SECRETS', 'FAKE_TAGS', 'FAKE_RUNNERS', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmod-doctor-json-'));
  for (const k of ENV) saved[k] = process.env[k];
  const fake = join(tmp, 'fake-gh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');
const s = a.join(' ');
const out = x => { process.stdout.write(x); process.exit(0); };
if (s === 'auth status') out('');
if (s === 'auth token') out('t0ken');
if (s === 'api repos/o/r/rulesets') out('[]');
if (a[0] === 'api' && /^repos\\/soundheart-studios\\/gmod\\/tags/.test(a[1])) out(process.env.FAKE_TAGS ?? '');
if (a[0] === 'api' && /^repos\\/o\\/r\\/actions\\/runners/.test(a[1])) out(process.env.FAKE_RUNNERS ?? '{"total_count":0,"runners":[]}');
if (a[0] === 'secret' && a[1] === 'list') out(process.env.FAKE_SECRETS ?? '');
process.stderr.write('fake gh: no reply for ' + s);
process.exit(1);
`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, {
    GMOD_GH: fake,
    GIT_SSH_VARIANT: 'simple',
    FAKE_GH_LOG: join(tmp, 'gh.log'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  });
});

after(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

function repo(name, files) {
  const bare = join(tmp, 'forge', name, 'o', 'r.git');
  mkdirSync(dirname(bare), { recursive: true });
  run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = join(tmp, `${name}-seed`);
  run('git', ['init', '-q', '-b', 'main', seed]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  run('git', ['add', '-A'], seed);
  run('git', ['commit', '-q', '-m', 'seed'], seed);
  run('git', ['push', '-q', bare, 'main'], seed);
  const work = join(tmp, `${name}-work`);
  cpSync(seed, work, { recursive: true });
  run('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], work);
  const ssh = join(tmp, `fake-ssh-${name}`);
  writeFileSync(ssh, `#!/bin/sh\ncd "${join(tmp, 'forge', name)}" || exit 1\nfor last; do :; done\neval "$last"\n`);
  chmodSync(ssh, 0o755);
  process.env.GIT_SSH_COMMAND = ssh;
  return work;
}

const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [] };
const IDS = ['plan', 'managed', 'workflow', 'runner', 'reviewer', 'protection', 'installed'];
const byId = r => Object.fromEntries(r.checks.map(c => [c.id, c]));

test('doctor --json: one check each, ok, missing or differs, each with a one-line fix when not ok', async () => {
  const work = repo('set-up', {
    '.gmod/plan.json': JSON.stringify(PLAN, null, 2) + '\n',
    '.gmod/managed.json': JSON.stringify({ v: 1, managed: true }) + '\n',
    '.gmod/protect.json': JSON.stringify({ require: ['gate', 'review'], up_to_date: true }) + '\n',
    '.github/workflows/gmod.yml': actionWorkflow({ ref: 'v1.4.7', reviewer: { kind: 'openai', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }, blocking: false, runsOn: 'gpu-box' }),
  });
  process.env.FAKE_TAGS = ['v1.4.7', `v${VERSION}`, 'v99.0.0'].join('\n');
  process.env.FAKE_SECRETS = '';
  process.env.FAKE_RUNNERS = JSON.stringify({ total_count: 1, runners: [{ name: 'tower', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'gpu-box' }] }] });
  const r = await doctor(work);
  assert.deepEqual(r.checks.map(c => c.id), IDS);
  for (const c of r.checks) {
    assert.ok(['ok', 'missing', 'differs'].includes(c.status), JSON.stringify(c));
    assert.equal(typeof c.detail, 'string');
    if (c.status !== 'ok') assert.ok(c.fix && !c.fix.includes('\n'), `a one-line fix: ${JSON.stringify(c)}`);
  }
  const c = byId(r);
  assert.equal(c.plan.status, 'ok');
  assert.equal(c.managed.status, 'ok');
  assert.match(c.managed.detail, /\bon\b/);
  assert.equal(c.workflow.status, 'differs', 'pinned to an older gmod');
  assert.match(c.workflow.detail, /v1\.4\.7/);
  assert.match(c.workflow.fix, /gmod ci upgrade/);
  assert.equal(c.runner.status, 'ok');
  assert.match(c.runner.detail, /gpu-box/);
  assert.equal(c.reviewer.status, 'missing', 'its key is not set');
  assert.match(c.reviewer.detail, /deepseek-flash/);
  assert.match(c.reviewer.detail, /advice/);
  assert.match(c.reviewer.fix, /GMOD_REVIEW_KEY/);
  assert.equal(c.protection.status, 'differs', 'main has no rules yet');
  assert.match(c.protection.fix, /gmod ci protect/);
  assert.equal(c.installed.status, 'differs');
  assert.match(c.installed.detail, new RegExp(VERSION.replace(/\./g, '\\.')));
  assert.match(c.installed.detail, /99\.0\.0/);
  // The findings are still there, for the CLI.
  assert.ok(r.findings.length);
});

test('doctor --json on a bare repository: what is missing, and how to set it up', async () => {
  const work = repo('bare', { 'README.md': 'hi\n' });
  process.env.FAKE_TAGS = `v${VERSION}`;
  const c = byId(await doctor(work));
  assert.equal(c.plan.status, 'missing');
  assert.equal(c.managed.status, 'ok');
  assert.match(c.managed.detail, /\boff\b/);
  assert.equal(c.workflow.status, 'missing');
  assert.match(c.workflow.fix, /gmod setup/);
  assert.equal(c.runner.status, 'missing');
  assert.equal(c.reviewer.status, 'missing');
  assert.equal(c.protection.status, 'missing');
  assert.equal(c.installed.status, 'ok');
});

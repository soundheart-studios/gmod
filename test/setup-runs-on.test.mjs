// gmod setup --runs-on on GitHub, and doctor's look at the runner it names.
// No network: origin is git@github.com:o/r.git, but ssh is a script that runs
// git's own command against a bare repository here, and gh is a fake
// (GMOD_GH) that answers from a few canned replies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionWorkflow, doctor, setup } from '../lib/setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PLAN_JSON = readFileSync(join(here, '..', '.gmod', 'plan.json'), 'utf8');
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let tmp;
const saved = {};
const ENV = ['GMOD_GH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'FAKE_GH_LOG', 'FAKE_RUNNERS', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmod-runs-on-'));
  for (const k of ENV) saved[k] = process.env[k];
  const ssh = join(tmp, 'fake-ssh');
  // git calls: <ssh> git@github.com "git-upload-pack 'o/r.git'"
  writeFileSync(ssh, `#!/bin/sh\ncd "${join(tmp, 'forge')}" || exit 1\nfor last; do :; done\neval "$last"\n`);
  chmodSync(ssh, 0o755);
  const fake = join(tmp, 'fake-gh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');
const s = a.join(' ');
const out = x => { process.stdout.write(x); process.exit(0); };
if (s === 'auth status') out('');
if (s === 'api repos/o/r/rulesets') out('[]');
if (/^api -X (POST|PUT) repos\\/o\\/r\\/rulesets/.test(s)) out('{}');
if (a[0] === 'pr' && a[1] === 'create') out('https://github.com/o/r/pull/1\\n');
if (a[0] === 'secret' && a[1] === 'list') out('');
if (a[0] === 'api' && /^repos\\/o\\/r\\/actions\\/runners/.test(a[1])) out(process.env.FAKE_RUNNERS ?? '{"total_count":0,"runners":[]}');
if (a[0] === 'api' && /^orgs\\/o\\/actions\\/runners/.test(a[1])) { process.stderr.write('HTTP 404'); process.exit(1); }
process.stderr.write('fake gh: no reply for ' + s);
process.exit(1);
`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, {
    GMOD_GH: fake,
    GIT_SSH_COMMAND: ssh,
    GIT_SSH_VARIANT: 'simple',
    FAKE_GH_LOG: join(tmp, 'gh.log'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  });
});

after(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

// A GitHub repository o/r whose main has a plan and, if given, more files.
function repo(name, files = {}) {
  const bare = join(tmp, 'forge', name, 'o', 'r.git');
  mkdirSync(dirname(bare), { recursive: true });
  run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = join(tmp, `${name}-seed`);
  run('git', ['init', '-q', '-b', 'main', seed]);
  for (const [path, text] of Object.entries({ '.gmod/plan.json': PLAN_JSON, ...files })) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  run('git', ['add', '-A'], seed);
  run('git', ['commit', '-q', '-m', 'seed'], seed);
  run('git', ['push', '-q', bare, 'main'], seed);
  const work = join(tmp, `${name}-work`);
  cpSync(seed, work, { recursive: true });
  run('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], work);
  // The fake ssh serves forge/<name>/o/r.git.
  process.env.GIT_SSH_COMMAND = join(tmp, 'fake-ssh');
  writeFileSync(join(tmp, 'fake-ssh'), `#!/bin/sh\ncd "${join(tmp, 'forge', name)}" || exit 1\nfor last; do :; done\neval "$last"\n`);
  return { bare, work };
}

test('setup --runs-on <label> on GitHub writes runs-on: <label>', async () => {
  const { bare, work } = repo('setup');
  const r = await setup(work, { reviewer: { kind: 'none' }, ref: 'v1.4.7', runsOn: 'gpu-box', wait: false });
  assert.ok(r.ok, JSON.stringify(r.steps));
  const wf = run('git', ['--git-dir', bare, 'show', 'gmod/setup:.github/workflows/gmod.yml']);
  assert.match(wf, /^ {4}runs-on: gpu-box$/m);
  assert.doesNotMatch(wf, /ubuntu-latest/);
  assert.match(wf, /repository_dispatch/, 'still the GitHub workflow');
});

test('setup without --runs-on on GitHub still runs on ubuntu-latest', async () => {
  const { bare, work } = repo('plain');
  const r = await setup(work, { reviewer: { kind: 'none' }, ref: 'v1.4.7', wait: false });
  assert.ok(r.ok, JSON.stringify(r.steps));
  assert.match(run('git', ['--git-dir', bare, 'show', 'gmod/setup:.github/workflows/gmod.yml']), /^ {4}runs-on: ubuntu-latest$/m);
});

const runnerFinding = r => r.findings.find(f => /runner/.test(f.msg));

test('doctor reports a self-hosted label that no runner carries, with the fix', async () => {
  const { work } = repo('doctor-missing', { '.github/workflows/gmod.yml': actionWorkflow({ ref: 'v1.4.7', reviewer: { kind: 'none' }, runsOn: 'gpu-box' }) });
  process.env.FAKE_RUNNERS = JSON.stringify({ total_count: 1, runners: [{ name: 'mini', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'macOS' }] }] });
  const r = await doctor(work);
  const f = runnerFinding(r);
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.ok, false);
  assert.match(f.msg, /gpu-box/);
  assert.match(f.fix, /gpu-box/);
  assert.match(f.fix, /o\/r/);
  assert.equal(r.ok, false);
});

test('doctor passes a self-hosted label a runner carries, and leaves hosted runners alone', async () => {
  const { work } = repo('doctor-found', { '.github/workflows/gmod.yml': actionWorkflow({ ref: 'v1.4.7', reviewer: { kind: 'none' }, runsOn: 'gpu-box' }) });
  process.env.FAKE_RUNNERS = JSON.stringify({ total_count: 1, runners: [{ name: 'tower', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'gpu-box' }] }] });
  const f = runnerFinding(await doctor(work));
  assert.ok(f);
  assert.equal(f.ok, true);
  assert.match(f.msg, /tower/);

  const hosted = repo('doctor-hosted', { '.github/workflows/gmod.yml': actionWorkflow({ ref: 'v1.4.7', reviewer: { kind: 'none' } }) });
  writeFileSync(process.env.FAKE_GH_LOG, '');
  const h = await doctor(hosted.work);
  assert.equal(runnerFinding(h), undefined, 'ubuntu-latest needs no runner of yours');
  assert.doesNotMatch(readFileSync(process.env.FAKE_GH_LOG, 'utf8'), /actions\/runners/);
});

// gmod doctor on GitHub names how branches CI catches up with main get checked
// again: the GitHub App (its pushes start runs by themselves) or
// repository_dispatch (gmod starts the run), and flags a workflow with neither.
// No network: origin is git@github.com:o/r.git served from a bare repository
// here by a fake ssh, and gh is a fake (GMOD_GH).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionWorkflow, doctor } from '../lib/setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PLAN_JSON = readFileSync(join(here, '..', '.gmod', 'plan.json'), 'utf8');
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let tmp;
const saved = {};
const ENV = ['GMOD_GH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'FAKE_GH_LOG', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmod-doctor-catch-up-'));
  for (const k of ENV) saved[k] = process.env[k];
  const fake = join(tmp, 'fake-gh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');
const s = a.join(' ');
const out = x => { process.stdout.write(x); process.exit(0); };
if (s === 'auth status') out('');
if (a[0] === 'secret' && a[1] === 'list') out('');
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

// A GitHub repository o/r whose main has a plan and this workflow.
function repo(name, workflow) {
  const bare = join(tmp, 'forge', name, 'o', 'r.git');
  mkdirSync(dirname(bare), { recursive: true });
  run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = join(tmp, `${name}-seed`);
  run('git', ['init', '-q', '-b', 'main', seed]);
  for (const [path, text] of Object.entries({ '.gmod/plan.json': PLAN_JSON, '.github/workflows/gmod.yml': workflow })) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  run('git', ['add', '-A'], seed);
  run('git', ['commit', '-q', '-m', 'seed'], seed);
  run('git', ['push', '-q', bare, 'main'], seed);
  const work = join(tmp, `${name}-work`);
  cpSync(seed, work, { recursive: true });
  run('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], work);
  const ssh = join(tmp, `ssh-${name}`);
  writeFileSync(ssh, `#!/bin/sh\ncd "${join(tmp, 'forge', name)}" || exit 1\nfor last; do :; done\neval "$last"\n`);
  chmodSync(ssh, 0o755);
  process.env.GIT_SSH_COMMAND = ssh;
  return work;
}

const catchUp = r => r.findings.filter(f => /catch(es)? up|caught up|catch-up/i.test(f.msg));

test('doctor names the GitHub App path when the workflow has app keys', async () => {
  const work = repo('app', actionWorkflow({ ref: 'v1.4.7', reviewer: { kind: 'none' }, app: true }));
  const r = await doctor(work);
  const fs = catchUp(r);
  assert.equal(fs.length, 1, JSON.stringify(r.findings));
  assert.equal(fs[0].ok, true);
  assert.match(fs[0].msg, /GitHub App/);
  assert.doesNotMatch(fs[0].msg, /repository_dispatch/);
  assert.equal(r.findings.filter(f => /follow-up runs/.test(f.msg)).length, 0, 'the old dispatch finding is folded in');
});

test('doctor names repository_dispatch when the workflow has no app keys', async () => {
  const work = repo('dispatch', actionWorkflow({ ref: 'v1.4.7', reviewer: { kind: 'none' } }));
  const r = await doctor(work);
  const fs = catchUp(r);
  assert.equal(fs.length, 1, JSON.stringify(r.findings));
  assert.equal(fs[0].ok, true);
  assert.match(fs[0].msg, /repository_dispatch/);
  assert.doesNotMatch(fs[0].msg, /GitHub App/);
});

test('doctor flags a workflow with neither path, with gmod setup as the fix', async () => {
  const wf = actionWorkflow({ ref: 'v1.4.7', reviewer: { kind: 'none' } }).replace(/^ *repository_dispatch:.*\n/m, '');
  assert.doesNotMatch(wf, /repository_dispatch|app-id/);
  const work = repo('neither', wf);
  const r = await doctor(work);
  const fs = catchUp(r);
  assert.equal(fs.length, 1, JSON.stringify(r.findings));
  assert.equal(fs[0].ok, false);
  assert.equal(fs[0].fix, 'gmod setup');
  assert.equal(r.ok, false);
});

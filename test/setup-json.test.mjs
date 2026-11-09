// gmod setup --json, run from a person's surface (Skiff's Govern): one call
// that writes a starter plan when there is none, the CI workflow and
// protect.json, turns managed mode on when asked, lands it as setup's pull
// request, and prints one JSON result: each step's status, the pull request,
// and what is left for the person. --managed is the person's switch, as
// `gmod manage on` is. No network: the same fake ssh and gh as
// setup-runs-on.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../lib/setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GMOD = join(here, '..', 'bin', 'gmod.mjs');
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let tmp;
const saved = {};
const ENV = ['GMOD_GH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'FAKE_GH_LOG', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmod-setup-json-'));
  for (const k of ENV) saved[k] = process.env[k];
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
if (a[0] === 'pr' && a[1] === 'create') out('https://github.com/o/r/pull/7\\n');
if (a[0] === 'pr' && a[1] === 'list') out('[]');
if (a[0] === 'pr' && a[1] === 'merge') out('');
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

// A GitHub repository o/r whose main holds `files` (no plan unless given).
function repo(name, files = { 'README.md': 'hi\n' }) {
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
  run('git', ['config', 'user.email', 'person@x.io'], work);
  const ssh = join(tmp, `fake-ssh-${name}`);
  writeFileSync(ssh, `#!/bin/sh\ncd "${join(tmp, 'forge', name)}" || exit 1\nfor last; do :; done\neval "$last"\n`);
  chmodSync(ssh, 0o755);
  process.env.GIT_SSH_COMMAND = ssh;
  return { bare, work };
}

const show = (bare, path) => run('git', ['--git-dir', bare, 'show', `gmod/setup:${path}`]);

test('setup --json: a starter plan, the workflow, protect.json and managed mode in one pull request, with each step and what is left', async () => {
  const { bare, work } = repo('fresh');
  const r = await setup(work, { reviewer: { kind: 'claude' }, ref: 'v1.8.0', wait: false, managed: true, via: 'skiff' });

  // One pull request holds all of it.
  assert.equal(r.pr?.url, 'https://github.com/o/r/pull/7');
  const plan = JSON.parse(show(bare, '.gmod/plan.json'));
  assert.equal(plan.main, 'main');
  assert.deepEqual(plan.jobs, []);
  assert.match(show(bare, '.github/workflows/gmod.yml'), /soundheart-studios\/gmod@v1\.8\.0/);
  assert.ok(show(bare, '.gmod/protect.json'));
  assert.deepEqual(JSON.parse(show(bare, '.gmod/managed.json')), { v: 1, managed: true });
  const msg = run('git', ['--git-dir', bare, 'log', '-1', '--format=%B', 'gmod/setup']);
  assert.match(msg, /^Decided-By: person@x\.io$/m);
  assert.match(msg, /^Decided-Via: skiff$/m);

  // Each step says what happened; what's left is said in words.
  for (const s of r.steps) {
    assert.equal(typeof s.id, 'string', JSON.stringify(s));
    assert.ok(['done', 'skipped', 'failed'].includes(s.status), JSON.stringify(s));
    assert.equal(typeof s.detail, 'string');
  }
  const ids = r.steps.map(s => s.id);
  for (const id of ['plan', 'protect', 'pr', 'managed']) assert.ok(ids.includes(id), `a ${id} step: ${ids}`);
  assert.equal(r.steps.find(s => s.id === 'plan').status, 'done');
  assert.equal(r.steps.find(s => s.id === 'managed').status, 'done');
  assert.ok(r.left.some(l => /ANTHROPIC_API_KEY/.test(l) && /secret/.test(l)), `the reviewer's key is left: ${JSON.stringify(r.left)}`);
});

test('setup --json on a repository that already has a plan keeps it, and skips managed mode unless asked', async () => {
  const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'a', goal: 'A', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'a', check: 'ok' }] }] };
  const { bare, work } = repo('governed', { '.gmod/plan.json': JSON.stringify(PLAN, null, 2) + '\n' });
  const r = await setup(work, { reviewer: { kind: 'none' }, ref: 'v1.8.0', wait: false });
  assert.ok(r.ok, JSON.stringify(r.steps));
  assert.equal(r.steps.find(s => s.id === 'plan').status, 'skipped');
  assert.equal(r.steps.find(s => s.id === 'managed').status, 'skipped');
  assert.throws(() => show(bare, '.gmod/managed.json'));
  assert.deepEqual(r.left, []);
});

test('setup --managed is the person\'s switch: refused under an agent, and without --yes when no terminal', () => {
  const { work } = repo('person');
  writeFileSync(process.env.FAKE_GH_LOG, '');
  const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/;
  const person = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_VARS.test(k)));
  const gmod = (args, env = {}) => spawnSync('node', [GMOD, ...args], { cwd: work, env: { ...person, ...env }, encoding: 'utf8' });
  const a = gmod(['setup', '--json', '--managed', '--yes'], { CLAUDECODE: '1' });
  assert.notEqual(a.status, 0);
  assert.match(a.stderr + a.stdout, /only a person/);
  const b = gmod(['setup', '--json', '--managed']);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr + b.stdout, /--yes/);
  let log = '';
  try { log = readFileSync(process.env.FAKE_GH_LOG, 'utf8'); } catch { /* gh was never called */ }
  assert.equal(log.includes('"pr","create"'), false, 'nothing was opened');
});

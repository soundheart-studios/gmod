// Recorded outputs for surfaces that read gmod without the pane (Skiff copies
// test/fixtures/v1/ into its crates/gmod-contract): signals with an agent's
// request and a stuck job, doctor --json and setup --json. Each is made here
// from a real run in a scratch repository (the forge faked as the setup tests
// do) and compared by shape, so a fixture fails the moment what gmod prints
// drifts from it. GMOD_RECORD=1 writes them afresh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionWorkflow, doctor, setup } from '../lib/setup.mjs';
import { COMMANDS } from '../lib/capabilities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const FIXTURES = join(here, 'fixtures', 'v1');
const GMOD = join(ROOT, 'bin', 'gmod.mjs');
const RECORD = process.env.GMOD_RECORD === '1';

// The shape of a value: keys and types, arrays as the union of their items.
function shape(v) {
  if (Array.isArray(v)) {
    const merged = {};
    let scalar = null;
    for (const x of v) {
      const s = shape(x);
      if (s && typeof s === 'object' && !Array.isArray(s)) Object.assign(merged, s);
      else scalar = s;
    }
    return v.length ? [Object.keys(merged).length ? sortKeys(merged) : scalar] : [];
  }
  if (v === null) return 'null';
  if (typeof v === 'object') return sortKeys(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])));
  return typeof v;
}
const sortKeys = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));

function matches(name, value) {
  const file = join(FIXTURES, name);
  if (RECORD || !existsSync(file)) {
    assert.ok(RECORD, `no fixture ${name}: record it with GMOD_RECORD=1`);
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    return;
  }
  const recorded = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(shape(value), shape(recorded), `${name} no longer has the recorded shape: record it again with GMOD_RECORD=1 and tell Skiff`);
}

// ---- a scratch world: an origin, an agent's clone and the person's ----

const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/;
const PERSON = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_VARS.test(k)));
const LOCAL = { ...PERSON, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: LOCAL, encoding: 'utf8' }).trim();
const gmod = (cwd, ...args) => {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: LOCAL, encoding: 'utf8' });
  assert.equal(r.status === 0 || args[0] === 'check', true, `gmod ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('signals with an open request and a stuck job: request-signals.json', () => {
  const top = mkdtempSync(join(tmpdir(), 'gmod-fixtures-'));
  try {
    const origin = join(top, 'origin.git');
    git(top, 'init', '-q', '--bare', '-b', 'main', origin);
    const clone = name => {
      const dir = join(top, name);
      git(top, 'clone', '-q', origin, dir);
      git(dir, 'config', 'user.email', `${name}@example.com`);
      git(dir, 'config', 'user.name', name);
      return dir;
    };
    const seed = clone('seed');
    const plan = {
      main: 'main',
      checks: { sum: 'node test/sum.test.mjs', money: 'true' },
      jobs: [
        { id: 'add-sum', goal: 'Add two numbers', files: ['src/sum.mjs'], tests: ['test/sum.test.mjs'], done_when: [{ text: 'sum adds', check: 'sum' }] },
        { id: 'money', goal: 'Store money', files: ['src/money.mjs'], tests: ['test/money.test.mjs'], done_when: [{ text: 'money round-trips', check: 'money' }] },
      ],
    };
    mkdirSync(join(seed, '.gmod'));
    mkdirSync(join(seed, 'src'));
    writeFileSync(join(seed, '.gmod', 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    writeFileSync(join(seed, 'src', 'sum.mjs'), 'export const sum = () => 0;\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');

    // One agent left add-sum red; another asks about money.
    const red = clone('agent-1');
    gmod(red, 'claim', 'add-sum');
    mkdirSync(join(red, 'test'));
    writeFileSync(join(red, 'test', 'sum.test.mjs'), "import { sum } from '../src/sum.mjs';\nif (sum(2, 3) !== 5) process.exit(1);\n");
    gmod(red, 'check');
    const asking = clone('agent-2');
    gmod(asking, 'claim', 'money');
    gmod(asking, 'ask', 'Store money as integer cents or as decimals?', '--options', '["integer cents","decimals"]');

    const person = clone('person');
    const out = JSON.parse(gmod(person, 'signals', '--json'));
    const request = out.signals.find(s => 'request' in s.cause);
    const stuck = out.signals.find(s => 'stuck' in s.cause);
    assert.ok(request && stuck, JSON.stringify(out.signals));
    assert.deepEqual(request.actions, ['answer', 'resolve']);
    assert.deepEqual(stuck.actions, ['open', 'rebrief', 'resolve']);
    assert.ok(request.rev && stuck.rev);
    matches('signals-request.json', out);

    // What gmod requests --json --all says after the person answers.
    gmod(person, 'decide', request.id, 'answer', '--note', 'integer cents', '--via', 'skiff');
    const all = JSON.parse(gmod(person, 'requests', '--json', '--all'));
    assert.equal(all.requests[0].answer, 'integer cents');
    matches('requests-answered.json', all);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

// ---- doctor --json and setup --json, against a faked GitHub ----

let tmp;
const saved = {};
const ENV = ['GMOD_GH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'FAKE_GH_LOG', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmod-fixtures-gh-'));
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
if (/^api -X (POST|PUT) repos\\/o\\/r\\/rulesets/.test(s)) out('{}');
if (a[0] === 'api' && /^repos\\/soundheart-studios\\/gmod\\/tags/.test(a[1])) out('v${VERSION}\\n');
if (a[0] === 'pr' && a[1] === 'create') out('https://github.com/o/r/pull/1\\n');
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

function repo(name, files) {
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
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
  run('git', ['config', 'user.email', 'person@example.com'], work);
  const ssh = join(tmp, `fake-ssh-${name}`);
  writeFileSync(ssh, `#!/bin/sh\ncd "${join(tmp, 'forge', name)}" || exit 1\nfor last; do :; done\neval "$last"\n`);
  chmodSync(ssh, 0o755);
  process.env.GIT_SSH_COMMAND = ssh;
  return work;
}

// What the CLI's --json prints: the result as JSON (the forge included).
const asPrinted = r => JSON.parse(JSON.stringify(r));

test('doctor --json: doctor.json', async () => {
  const work = repo('doctor', {
    '.gmod/plan.json': JSON.stringify({ main: 'main', checks: {}, jobs: [] }, null, 2) + '\n',
    '.gmod/protect.json': JSON.stringify({ require: ['gate', 'review'], up_to_date: true }) + '\n',
    '.github/workflows/gmod.yml': actionWorkflow({ ref: `v${VERSION}`, reviewer: { kind: 'openai', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }, blocking: false }),
  });
  const r = asPrinted(await doctor(work));
  assert.deepEqual(r.checks.map(c => c.id), ['plan', 'managed', 'workflow', 'runner', 'reviewer', 'protection', 'installed']);
  matches('doctor.json', r);
});

test('setup --json --managed on a new repository: setup.json', async () => {
  const work = repo('setup', { 'README.md': 'hi\n' });
  const r = asPrinted(await setup(work, { reviewer: { kind: 'openai', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }, blocking: false, ref: `v${VERSION}`, wait: false, managed: true, via: 'skiff' }));
  assert.ok(r.pr?.url);
  assert.ok(r.left.length, 'the reviewer key is left for the person');
  matches('setup.json', r);
});

test('capabilities lists the 1.8 commands, and docs/surfaces.md describes them', () => {
  for (const c of ['ask', 'requests', 'setup', 'doctor']) assert.ok(COMMANDS.includes(c), `capabilities lists ${c}`);
  const doc = readFileSync(join(ROOT, 'docs', 'surfaces.md'), 'utf8');
  for (const r of ['refs/gmod/requests', 'refs/gmod/resolved']) assert.ok(doc.includes(r), `names ${r}`);
  for (const a of ['answer', 'resolve', 'rebrief']) assert.ok(doc.includes(`\`${a}\``), `names the ${a} action`);
  for (const c of ['gmod ask', 'gmod requests', 'setup --json', 'doctor --json']) assert.ok(doc.includes(c), `names ${c}`);
  assert.ok(doc.includes('test/fixtures/v1/'), 'points Skiff to the fixtures');
  assert.match(doc, /protocol v1/i);
  assert.doesNotMatch(doc, /requests, packs\) stays behind managed mode/, 'requests are core now');
});

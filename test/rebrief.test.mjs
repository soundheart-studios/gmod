// Re-brief a stuck job (part of E6): `gmod decide <id> rebrief --note <brief>`
// replaces that job's brief as the person's decision, committed alone like an
// approve, with no proposal. It frees the job's claim, whoever holds it, so
// the next worker starts fresh from the new brief. It is refused for a done
// job, an empty note, under an agent, and while a pending proposal changes the
// same job (the refusal names that proposal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/;
const PERSON = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_VARS.test(k)));
const ENV = { ...PERSON, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function gmod(cwd, args, env = {}) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: { ...ENV, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const ok = (cwd, args, env) => {
  const r = gmod(cwd, args, env);
  assert.equal(r.code, 0, `gmod ${args.join(' ')}: ${r.err}`);
  return r.out;
};
function write(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

const PLAN = {
  main: 'main',
  checks: { sum: 'node test/sum.test.mjs', ok: 'true' },
  jobs: [
    { id: 'add-sum', goal: 'Add two numbers', brief: 'Use floats.', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }] },
    { id: 'add-neg', goal: 'Negate', files: ['lib/neg/**'], tests: ['spec/neg/**'], done_when: [{ text: 'negates', check: 'ok' }] },
  ],
};
const TEST = "import { sum } from '../src/sum.mjs';\nif (sum(2, 3) !== 5) process.exit(1);\n";

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-rebrief-'));
  const origin = join(top, 'origin.git');
  sh(top, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = name => {
    const dir = join(top, name);
    sh(top, 'clone', '-q', origin, dir);
    sh(dir, 'config', 'user.email', `${name}@x.io`);
    sh(dir, 'config', 'user.name', name);
    return dir;
  };
  const seed = clone('owner');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2) + '\n', 'src/sum.mjs': 'export const sum = () => 0;\n' });
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'seed the plan');
  sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  return { origin, agent: clone('agent'), person: clone('person'), done: () => rmSync(top, { recursive: true, force: true }) };
}

const stuckSignal = dir => JSON.parse(ok(dir, ['signals', '--json'])).signals.find(s => s.cause?.stuck === 'add-sum');
const planOf = dir => JSON.parse(readFileSync(join(dir, '.gmod', 'plan.json'), 'utf8'));
const claimOnOrigin = w => spawnSync('git', ['--git-dir', w.origin, 'rev-parse', '-q', '--verify', 'refs/gmod/claims/add-sum'], { env: ENV }).status === 0;

function stuckWorld() {
  const w = world();
  ok(w.agent, ['claim', 'add-sum']);
  write(w.agent, { 'test/sum.test.mjs': TEST });
  gmod(w.agent, ['check']); // red
  return w;
}

test('rebrief commits only the new brief as the person\'s decision and frees the claim', () => {
  const w = stuckWorld();
  try {
    const s = stuckSignal(w.person);
    assert.ok(s.actions.includes('rebrief'), `offers rebrief: ${s.actions}`);
    assert.ok(claimOnOrigin(w), 'claimed before');
    const before = sh(w.person, 'rev-parse', 'HEAD');

    ok(w.person, ['decide', s.id, 'rebrief', '--note', 'Use integer cents; never floats.', '--via', 'skiff', '--no-pr']);
    assert.equal(sh(w.person, 'rev-parse', 'HEAD~1'), before, 'one commit');
    assert.deepEqual(sh(w.person, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n'), ['.gmod/plan.json'], 'only the plan');
    assert.match(sh(w.person, 'log', '-1', '--format=%s'), /^plan: rebrief add-sum/);
    const msg = sh(w.person, 'log', '-1', '--format=%B');
    assert.match(msg, /^Decided-By: person@x\.io$/m);
    assert.match(msg, /^Decided-Via: skiff$/m);
    const plan = planOf(w.person);
    assert.equal(plan.jobs.find(j => j.id === 'add-sum').brief, 'Use integer cents; never floats.');
    assert.deepEqual(plan.jobs.find(j => j.id === 'add-neg'), PLAN.jobs[1], 'nothing else changes');
    assert.equal(claimOnOrigin(w), false, 'the claim is freed on origin');
  } finally { w.done(); }
});

test('rebrief is refused for an empty note, under an agent, for a done job, and while a proposal changes the job', () => {
  const w = stuckWorld();
  try {
    const s = stuckSignal(w.person);
    const head = sh(w.person, 'rev-parse', 'HEAD');
    const refused = (args, pattern, env) => {
      const r = gmod(w.person, ['decide', s.id, 'rebrief', ...args, '--via', 'skiff', '--no-pr'], env);
      assert.notEqual(r.code, 0, `refused: ${args.join(' ')}`);
      assert.match(r.err, pattern);
      assert.equal(sh(w.person, 'rev-parse', 'HEAD'), head, 'nothing committed');
    };
    refused([], /--note/);
    refused(['--note', 'x'], /only a person decides/, { CLAUDECODE: '1' });

    // A pending proposal that changes add-sum is in the way, and is named.
    ok(w.agent, ['edit-job', 'add-sum', JSON.stringify({ goal: 'Add two integers' })]);
    ok(w.agent, ['describe-proposal', '--summary', 'Integers only']);
    const p = JSON.parse(ok(w.person, ['signals', '--json'])).signals.find(x => 'proposal' in x.cause);
    const r = gmod(w.person, ['decide', s.id, 'rebrief', '--note', 'x', '--via', 'skiff', '--no-pr']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /Integers only/);
    assert.match(r.err, /agent@x\.io/);
    assert.ok(r.err.includes(p.id), `names the proposal's signal: ${r.err}`);
    assert.match(r.err, /approve or reject/);

    // A done job has nothing left to brief.
    sh(w.person, 'commit', '-q', '--allow-empty', '-m', 'add-neg: negate');
    sh(w.person, 'push', '-q', 'origin', 'HEAD:main');
    const done = gmod(w.person, ['rebrief', 'add-neg', '--note', 'x', '--no-pr']);
    assert.notEqual(done.code, 0);
    assert.match(done.err, /already done/);

    // A proposal about another job is no obstacle.
    ok(w.person, ['decide', p.id, 'reject', '--via', 'skiff']);
    ok(w.person, ['propose-job', JSON.stringify({ id: 'add-mul', goal: 'Multiply', files: ['lib/mul/**'], tests: ['spec/mul/**'], done_when: [{ text: 'multiplies', check: 'ok' }] })]);
    ok(w.person, ['decide', s.id, 'rebrief', '--note', 'Integer cents.', '--via', 'skiff', '--no-pr']);
  } finally { w.done(); }
});

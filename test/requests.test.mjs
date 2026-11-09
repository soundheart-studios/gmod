// Requests: an agent asks the person, the person answers (E5 in Skiff's
// brief for 1.8). `gmod ask` raises a request for the job claimed here,
// shared like a proposal (refs/gmod/requests/<id>), so every clone shows it as
// a signal with actions answer and resolve. Only a person answers, from the
// options when there are some. The asking worktree's notice gives the answer
// once; `gmod requests --all` keeps it readable until the job is done, so a
// fresh agent on the job (Skiff restarts its worker) can read it too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/;
const PERSON = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_VARS.test(k)));
const ENV = { ...PERSON, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const AGENT = { CLAUDECODE: '1' };
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
const refused = (cwd, args, pattern, env) => {
  const r = gmod(cwd, args, env);
  assert.notEqual(r.code, 0, `refused: gmod ${args.join(' ')}`);
  assert.match(r.err, pattern);
};

const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'add-sum', goal: 'Sum', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sums', check: 'ok' }] }] };

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-requests-'));
  const origin = join(top, 'origin.git');
  sh(top, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = (name, email) => {
    const dir = join(top, name);
    sh(top, 'clone', '-q', origin, dir);
    sh(dir, 'config', 'user.email', email);
    sh(dir, 'config', 'user.name', name);
    return dir;
  };
  const agent = clone('agent', 'agent@x.io');
  mkdirSync(join(agent, '.gmod'));
  writeFileSync(join(agent, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  sh(agent, 'add', '-A');
  sh(agent, 'commit', '-q', '-m', 'seed the plan');
  sh(agent, 'push', '-q', 'origin', 'HEAD:main');
  const person = clone('person', 'person@x.io');
  return { agent, person, done: () => rmSync(top, { recursive: true, force: true }) };
}

const requestSignals = dir => JSON.parse(ok(dir, ['signals', '--json'])).signals.filter(s => 'request' in s.cause);

test('an agent asks; every clone sees the request as a signal; only a person answers, from the options', () => {
  const w = world();
  try {
    refused(w.agent, ['ask', 'Cents or floats?'], /claim/, AGENT);
    ok(w.agent, ['claim', 'add-sum'], AGENT);
    const asked = JSON.parse(ok(w.agent, ['ask', 'Cents or floats?', '--options', '["cents","floats"]', '--json'], AGENT));
    assert.equal(asked.job, 'add-sum');
    assert.equal(asked.question, 'Cents or floats?');

    // On the person's clone: one signal, a decision with answer and resolve.
    const [s] = requestSignals(w.person);
    assert.ok(s, 'the request reaches the other clone');
    assert.equal(s.kind, 'decide');
    assert.equal(s.cause.request, asked.id);
    assert.match(s.question, /add-sum/);
    assert.match(s.question, /Cents or floats\?/);
    assert.match(s.detail, /cents/);
    assert.ok(s.rev, 'carries a rev');
    assert.deepEqual(s.actions, ['answer', 'resolve']);
    assert.equal(requestSignals(w.person)[0].id, s.id, 'the same id from run to run');
    assert.equal(requestSignals(w.agent)[0].id, s.id, 'and on every clone');

    // Not by an agent; not without an answer; not outside the options.
    refused(w.person, ['decide', s.id, 'answer', '--note', 'cents', '--via', 'skiff'], /only a person decides/, AGENT);
    refused(w.person, ['decide', s.id, 'answer', '--via', 'skiff'], /--note/);
    refused(w.person, ['decide', s.id, 'answer', '--note', 'pounds', '--via', 'skiff'], /cents, floats/);

    const r = JSON.parse(ok(w.person, ['decide', s.id, 'answer', '--note', 'cents', '--via', 'skiff', '--json']));
    assert.equal(r.decided, true);
    assert.deepEqual(requestSignals(w.person), [], 'answered: no longer waiting');
    assert.deepEqual(requestSignals(w.agent), [], 'anywhere');
  } finally { w.done(); }
});

test("the asking worktree's notice gives the answer once, and gmod requests --all keeps it readable", () => {
  const w = world();
  try {
    ok(w.agent, ['claim', 'add-sum'], AGENT);
    const asked = JSON.parse(ok(w.agent, ['ask', 'Round half up?', '--json'], AGENT));
    assert.equal(ok(w.agent, ['notice', '.'], AGENT), '', 'nothing to tell yet');
    const [s] = requestSignals(w.person);
    ok(w.person, ['decide', s.id, 'answer', '--note', 'yes, half up', '--via', 'skiff']);

    ok(w.agent, ['status', '--json'], AGENT); // a tool round syncs
    const told = ok(w.agent, ['notice', '.'], AGENT);
    assert.match(told, /answered/);
    assert.match(told, /Round half up\?/);
    assert.match(told, /yes, half up/);
    assert.equal(ok(w.agent, ['notice', '.'], AGENT), '', 'once');

    // Readable afterwards, on any clone: question, answer, who and when.
    assert.deepEqual(JSON.parse(ok(w.agent, ['requests', '--json'])).requests, [], 'none open');
    for (const dir of [w.agent, w.person]) {
      const all = JSON.parse(ok(dir, ['requests', '--json', '--all', '--job', 'add-sum'])).requests;
      const q = all.find(x => x.id === asked.id);
      assert.equal(q.question, 'Round half up?');
      assert.equal(q.answer, 'yes, half up');
      assert.equal(q.answeredBy, 'person@x.io');
      assert.ok(q.answeredAt);
      assert.equal(q.job, 'add-sum');
    }
  } finally { w.done(); }
});

test('resolve closes a request without an answer', () => {
  const w = world();
  try {
    ok(w.agent, ['claim', 'add-sum'], AGENT);
    const asked = JSON.parse(ok(w.agent, ['ask', 'Should I also do subtraction?', '--json'], AGENT));
    const [s] = requestSignals(w.person);
    ok(w.person, ['decide', s.id, 'resolve', '--note', 'out of scope', '--via', 'skiff']);
    assert.deepEqual(requestSignals(w.person), []);
    const q = JSON.parse(ok(w.person, ['requests', '--json', '--all'])).requests.find(x => x.id === asked.id);
    assert.equal(q.resolved, true);
    assert.equal(q.answer ?? null, null);
    assert.equal(q.note, 'out of scope');
    assert.ok(JSON.parse(ok(w.person, ['capabilities', '--json'])).commands.includes('ask'));
  } finally { w.done(); }
});

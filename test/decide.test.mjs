// gmod decide <signal-id> <action>: one action command for every surface
// (ADR 0002, docs/surfaces.md). It finds the signal by its id, does only what
// the signal offers, refuses a proposal that changed since the person saw it
// (--rev), and refuses to run under an agent: gmod's agent identity or an
// agent's environment. Without a terminal it needs --via <surface>. Every
// decision commit says who decided and through which surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentReason } from '../lib/decide.mjs';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
// A person's terminal: none of an agent's markers, whatever runs these tests.
const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/;
const PERSON = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_VARS.test(k)));
const ENV = { ...PERSON, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function gmod(cwd, args, env = {}) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: { ...ENV, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const ok = (cwd, ...args) => {
  const r = gmod(cwd, args);
  assert.equal(r.code, 0, `gmod ${args.join(' ')}: ${r.err}`);
  return r.out;
};

const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'add-sum', goal: 'Sum', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sums', check: 'ok' }] }] };
const NEG = { id: 'add-neg', goal: 'Negate', files: ['src/neg.mjs'], tests: ['test/neg.test.mjs'], done_when: [{ text: 'negates', check: 'ok' }] };
const DRAFT = { title: 'Sums never round', scope: ['src/**'], context: 'Money.', decision: 'No rounding.', rules: [{ level: 'must', text: 'never round inside sum' }] };

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-decide-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const dir = join(top, 'alice');
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(dir, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { dir, done: () => rmSync(top, { recursive: true, force: true }) };
}

const signal = (dir, key) => JSON.parse(ok(dir, 'signals', '--json')).signals.find(s => key in s.cause);
const message = dir => sh(dir, 'git', ['log', '-1', '--format=%B']);

test('decide approves a proposal and accepts an ADR draft by signal id, and the commits carry Decided-By and Decided-Via', () => {
  const w = world();
  try {
    ok(w.dir, 'propose-job', JSON.stringify(NEG));
    const p = signal(w.dir, 'proposal');
    ok(w.dir, 'decide', p.id, 'approve', '--rev', p.rev, '--via', 'skiff', '--no-pr');
    assert.match(sh(w.dir, 'git', ['log', '-1', '--format=%s']), /^plan: add add-neg/);
    assert.match(message(w.dir), /^Decided-By: alice@x\.io$/m);
    assert.match(message(w.dir), /^Decided-Via: skiff$/m);
    assert.equal(signal(w.dir, 'proposal'), undefined, 'approved: no longer waiting');

    ok(w.dir, 'adr', 'propose', JSON.stringify(DRAFT));
    const a = signal(w.dir, 'adr');
    ok(w.dir, 'decide', a.id, 'accept', '--via', 'linear', '--no-pr');
    assert.ok(existsSync(join(w.dir, 'docs', 'adr', '0001-sums-never-round.md')));
    assert.match(message(w.dir), /^adr: 0001 Sums never round/);
    assert.match(message(w.dir), /^Decided-By: alice@x\.io$/m);
    assert.match(message(w.dir), /^Decided-Via: linear$/m);

    // gmod approve itself records who decided too.
    ok(w.dir, 'propose-job', JSON.stringify({ ...NEG, id: 'add-mul', goal: 'Multiply' }));
    ok(w.dir, 'approve', '--no-pr');
    assert.match(message(w.dir), /^Decided-By: alice@x\.io$/m);
    assert.match(message(w.dir), /^Decided-Via: cli$/m);

    // Ask for changes: the note waits on the proposal for whoever drafts it.
    ok(w.dir, 'propose-job', JSON.stringify({ ...NEG, id: 'add-div', goal: 'Divide' }));
    const q = signal(w.dir, 'proposal');
    ok(w.dir, 'decide', q.id, 'ask-changes', '--note', 'divide by zero?', '--via', 'skiff');
    const view = JSON.parse(ok(w.dir, 'proposal', '--json'));
    assert.equal(view.asks.at(-1).note, 'divide by zero?');
    assert.equal(view.asks.at(-1).by, 'alice@x.io');
  } finally { w.done(); }
});

test("decide refuses a stale --rev, an action the signal doesn't offer, and any run under an agent identity or environment", () => {
  const w = world();
  try {
    ok(w.dir, 'propose-job', JSON.stringify(NEG));
    const p = signal(w.dir, 'proposal');
    const head = sh(w.dir, 'git', ['rev-parse', 'HEAD']);
    const refused = (args, env, pattern) => {
      const r = gmod(w.dir, ['decide', ...args, '--no-pr'], env);
      assert.notEqual(r.code, 0, `refused: ${args.join(' ')}`);
      assert.match(r.err, pattern);
      assert.equal(sh(w.dir, 'git', ['rev-parse', 'HEAD']), head, 'nothing committed');
    };

    // Changed since the person saw it.
    ok(w.dir, 'edit-job', 'add-neg', JSON.stringify({ goal: 'Negate a number' }));
    refused([p.id, 'approve', '--rev', p.rev, '--via', 'skiff'], {}, /changed since/);
    // Not offered for this signal; no such signal.
    refused([p.id, 'accept', '--via', 'skiff'], {}, /isn't offered/);
    refused(['deadbeef', 'approve', '--via', 'skiff'], {}, /no signal deadbeef/);
    // Under an agent's environment.
    for (const env of [{ CLAUDECODE: '1' }, { CODEX_SANDBOX: 'seatbelt' }, { GMOD_AGENT: '1' }, { CI: 'true' }]) {
      refused([p.id, 'approve', '--via', 'skiff'], env, /only a person decides/);
    }
    // Under gmod's agent identity.
    sh(w.dir, 'git', ['config', 'user.email', 'gmod-agent@users.noreply.github.com']);
    refused([p.id, 'approve', '--via', 'skiff'], {}, /only a person decides/);
    sh(w.dir, 'git', ['config', 'user.email', 'alice@x.io']);
    // No terminal, and no surface named.
    refused([p.id, 'approve'], {}, /--via/);

    assert.equal(agentReason(w.dir, PERSON), null, 'a person, in a person\'s environment, may decide');
  } finally { w.done(); }
});

test('decide --json prints the outcome and the new stamp', () => {
  const w = world();
  try {
    ok(w.dir, 'adr', 'propose', JSON.stringify(DRAFT));
    const a = signal(w.dir, 'adr');
    const r = JSON.parse(ok(w.dir, 'decide', a.id, 'reject', '--note', 'not yet', '--via', 'skiff', '--json'));
    assert.equal(r.id, a.id);
    assert.equal(r.action, 'reject');
    assert.equal(r.decided, true);
    assert.equal(r.via, 'skiff');
    assert.equal(r.stamp, ok(w.dir, 'stamp'), 'the stamp after the decision');
    assert.equal(signal(w.dir, 'adr'), undefined);
  } finally { w.done(); }
});

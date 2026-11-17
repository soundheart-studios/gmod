// gmod watch: the person's live plan view in a plain terminal, for hosts with
// no pane (Codex). Its logic is pure and tested without a terminal:
// sync(state, status) takes in what was read, step(state, key) gives the next
// state and at most one action, view(state, status, width) gives the lines.
// A decision goes through lib/decide.mjs with via 'watch' and the rev drawn.
// Every decision here is made in a throwaway repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, sync, step, view, act } from '../lib/watch.mjs';
import { board, proposalCard } from '../lib/render.mjs';
import { signalsFrom } from '../lib/signals.mjs';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
// A person's terminal, whatever runs these tests; in-process git too.
const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/;
for (const k of Object.keys(process.env)) if (AGENT_VARS.test(k)) delete process.env[k];
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' });
const ENV = { ...process.env };
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function gmod(cwd, args, opts = {}) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, ...opts });
  return { code: r.status, out: r.stdout.replace(/\n$/, ''), err: r.stderr.trim() };
}
const ok = (cwd, ...args) => {
  const r = gmod(cwd, args);
  assert.equal(r.code, 0, `gmod ${args.join(' ')}: ${r.err}`);
  return r.out;
};
const status = dir => JSON.parse(ok(dir, 'status'));

const job = (id, extra = {}) => ({ id, goal: `Do ${id}`, files: [`src/${id}.mjs`], tests: [`test/${id}.test.mjs`], done_when: [{ text: `${id} works`, check: 'ok' }], ...extra });
const PLAN = {
  main: 'main',
  checks: { ok: 'true' },
  phases: [
    { id: 'base', title: 'Base', outcome: 'The base is laid.', after: [] },
    { id: 'later', title: 'Later', outcome: 'Built on the base.', after: ['base'] },
  ],
  jobs: [job('a-one', { phase: 'base' }), job('a-two', { phase: 'base' }), job('b-one', { phase: 'later' })],
};
const NEW = job('a-three', { phase: 'base', goal: 'Add a third' });

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-watch-'));
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

const W = 80;
const press = (state, ...keys) => {
  let action = null;
  for (const k of keys) ({ state, action } = step(state, k));
  return { state, action };
};
const selected = lines => lines.find(l => l.startsWith('›'));
const strip = l => l.slice(2);
// From the top, move until the selected line matches.
function moveTo(state, status, re) {
  for (let i = 0; i < 50; i++) state = step(state, 'up').state;
  for (let i = 0; i < 50; i++) {
    const sel = selected(view(state, status, W));
    if (sel && re.test(sel)) return state;
    state = step(state, 'down').state;
  }
  assert.fail(`never reached ${re}`);
}

test('the view shows the board and the waiting proposal card; moving and opening a phase or a job changes what is shown', () => {
  const w = world();
  try {
    ok(w.dir, 'propose-job', JSON.stringify(NEW));
    ok(w.dir, 'describe-proposal', '--summary', 'A third job for the base');
    const st = status(w.dir);
    let state = sync(init(), st);
    const lines = view(state, st, W);
    for (const l of lines) assert.ok([...l].length <= W, `fits: ${l}`);
    const text = lines.map(strip).join('\n');
    // The board and the proposal card, as lib/render.mjs draws them.
    assert.ok(text.includes(board(st, { width: W - 2 })[0]), 'the progress line');
    assert.match(text, /Needs you/);
    for (const l of proposalCard(st, { width: W - 2 })) assert.ok(text.includes(l), `card line: ${l}`);
    assert.equal(lines.filter(l => l.startsWith('›')).length, 1, 'one line is selected');

    // Moving moves the selection.
    const first = selected(lines);
    state = step(state, 'down').state;
    assert.notEqual(selected(view(state, st, W)), first);
    state = step(state, 'up').state;
    assert.equal(selected(view(state, st, W)), first);

    // The later phase starts folded: opening it shows its job, and again folds it.
    assert.ok(!text.includes('b-one'), 'later is folded');
    state = moveTo(state, st, /▸ Later/);
    state = step(state, 'enter').state;
    let now = view(state, st, W).join('\n');
    assert.match(now, /▾ Later/);
    assert.match(now, /b-one/);
    assert.match(now, /Built on the base\./);
    state = step(state, 'enter').state;
    assert.doesNotMatch(view(state, st, W).join('\n'), /b-one/);

    // Opening a job shows its goal, criteria and files.
    state = moveTo(state, st, /a-one/);
    assert.doesNotMatch(view(state, st, W).join('\n'), /Do a-one/);
    state = step(state, 'enter').state;
    now = view(state, st, W).join('\n');
    assert.match(now, /Do a-one/);
    assert.match(now, /a-one works/);
    assert.match(now, /src\/a-one\.mjs/);
    // Folding the base phase hides its jobs.
    state = moveTo(state, st, /▾ Base/);
    state = step(state, 'enter').state;
    now = view(state, st, W).join('\n');
    assert.match(now, /▸ Base/);
    assert.doesNotMatch(now, /a-one/);

    // q quits.
    assert.deepEqual(step(state, 'q').action, { quit: true });
  } finally {
    w.done();
  }
});

test('approve from the view decides through gmod decide with via watch and the rev on screen; refused when the proposal changed or under an agent', async () => {
  const w = world();
  try {
    ok(w.dir, 'propose-job', JSON.stringify(NEW));
    let st = status(w.dir);
    const sig = signalsFrom(st).find(s => 'proposal' in s.cause);
    let state = sync(init(), st);
    state = moveTo(state, st, /Plan change waiting/);
    const { action } = step(state, 'a');
    assert.deepEqual(action, { decide: { id: sig.id, action: 'approve', rev: sig.rev } });

    // An agent's environment: refused, nothing decided.
    await assert.rejects(act(w.dir, action, { env: { ...process.env, CODEX_HOME: '/x' } }), /only a person decides/);
    await assert.rejects(act(w.dir, action, { env: { ...process.env, CLAUDECODE: '1' } }), /only a person decides/);
    assert.ok(signalsFrom(status(w.dir)).some(s => 'proposal' in s.cause), 'still waiting');

    // The proposal changed after it was drawn: the rev on screen is refused.
    ok(w.dir, 'edit-job', 'a-three', JSON.stringify({ goal: 'Add a third, differently' }));
    await assert.rejects(act(w.dir, action), /changed since you saw it/);

    // Drawn again, the new rev decides, via watch.
    st = status(w.dir);
    state = moveTo(sync(state, st), st, /Plan change waiting/);
    const again = step(state, 'a').action;
    assert.notEqual(again.decide.rev, action.decide.rev);
    const r = await act(w.dir, again);
    assert.equal(r.decided, true);
    assert.equal(r.via, 'watch');
    assert.match(sh(w.dir, 'git', ['log', '-1', '--format=%s']), /^plan: /);
    assert.match(sh(w.dir, 'git', ['log', '-1', '--format=%B']), /^Decided-Via: watch$/m);
  } finally {
    w.done();
  }
});

test('ask for changes takes a typed note, and reject asks for nothing more', () => {
  const w = world();
  try {
    ok(w.dir, 'propose-job', JSON.stringify(NEW));
    const st = status(w.dir);
    const sig = signalsFrom(st).find(s => 'proposal' in s.cause);
    let state = moveTo(sync(init(), st), st, /Plan change waiting/);
    let r = step(state, 'c');
    assert.equal(r.action, null);
    r = press(r.state, 'm', 'o', 'r', 'e', 'x', 'backspace', 'enter');
    assert.deepEqual(r.action, { decide: { id: sig.id, action: 'ask-changes', rev: sig.rev, note: 'more' } });
    assert.match(view(press(state, 'c', 'h', 'i').state, st, W).join('\n'), /hi/);
    assert.equal(press(state, 'c', 'escape', 'enter').action, null, 'escape cancels the note');
    assert.deepEqual(step(state, 'r').action, { decide: { id: sig.id, action: 'reject', rev: sig.rev } });
  } finally {
    w.done();
  }
});

test('without a terminal gmod watch prints the board once and exits', () => {
  const w = world();
  try {
    ok(w.dir, 'propose-job', JSON.stringify(NEW));
    const r = gmod(w.dir, ['watch', '--width', '60']);
    assert.equal(r.code, 0, r.err);
    const st = status(w.dir);
    assert.ok(r.out.startsWith(board(st, { width: 60 }).join('\n')), r.out);
    assert.match(r.out, /a-one/);
  } finally {
    w.done();
  }
});

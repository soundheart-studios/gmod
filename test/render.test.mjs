// The plan as plain text (lib/render.mjs), for hosts with no pane (Codex):
// the board, the proposal card and the decision card, built from real
// `gmod status` records of throwaway repositories, and `gmod board`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { board, proposalCard, adrCard } from '../lib/render.mjs';
import { signalsFrom } from '../lib/signals.mjs';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const k of Object.keys(ENV)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/.test(k)) delete ENV[k];
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function gmod(cwd, ...args) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.replace(/\n$/, ''), err: r.stderr.trim() };
}
const ok = (cwd, ...args) => {
  const r = gmod(cwd, ...args);
  assert.equal(r.code, 0, `gmod ${args.join(' ')}: ${r.err}`);
  return r.out;
};
const status = dir => JSON.parse(ok(dir, 'status'));

const job = (id, extra = {}) => ({ id, goal: `Do ${id}`, files: [`src/${id}.mjs`], tests: [`test/${id}.test.mjs`], done_when: [{ text: `${id} works`, check: 'ok' }], ...extra });
const PHASED = {
  main: 'main',
  checks: { ok: 'true' },
  phases: [
    { id: 'base', title: 'Base', outcome: 'The base is laid.', after: [] },
    { id: 'later', title: 'Later', outcome: 'Built on the base.', after: ['base'] },
  ],
  jobs: [job('a-one', { phase: 'base' }), job('a-two', { phase: 'base' }), job('b-one', { phase: 'later' }), job('b-two', { phase: 'later' })],
};
const FLAT = { main: 'main', checks: { ok: 'true' }, jobs: [job('first'), job('second', { after: ['first'] })] };

function world(plan) {
  const top = mkdtempSync(join(tmpdir(), 'gmod-render-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const dir = join(top, 'alice');
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(dir, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  return { dir, done: () => rmSync(top, { recursive: true, force: true }) };
}

const len = l => [...l].length;
function fits(lines, width) {
  assert.ok(Array.isArray(lines) && lines.length > 0, 'some lines');
  for (const l of lines) {
    assert.equal(typeof l, 'string');
    assert.ok(len(l) <= width, `within ${width}: ${JSON.stringify(l)} (${len(l)})`);
    assert.ok(!/\u001b\[/.test(l), `no colour codes: ${JSON.stringify(l)}`);
  }
}
const row = (lines, id) => lines.find(l => new RegExp(`\\s${id}(\\s|$)`).test(l));
// The step marks of a job's row: what follows its id.
const stepMarks = (line, id) => (line.slice(line.indexOf(id) + id.length).match(/[●○✗!]/g) ?? []).join('');

// A proposal with a new phase and its jobs (two overlapping, for a warning),
// a changed job and a dropped one, described with assumptions.
function propose(dir) {
  ok(dir, 'propose-phase', JSON.stringify({ id: 'extra', title: 'Extra', outcome: 'More on top.', after: ['base'] }));
  ok(dir, 'propose-job', JSON.stringify(job('c-new', { phase: 'extra', files: ['src/shared.mjs'], done_when: [{ text: 'c-new really works', check: 'ok' }] })));
  ok(dir, 'propose-job', JSON.stringify(job('c-twin', { phase: 'extra', files: ['src/shared.mjs'] })));
  ok(dir, 'edit-job', 'a-two', JSON.stringify({ goal: 'Do a-two better' }));
  ok(dir, 'drop-job', 'b-one', '--reason', 'not needed any more');
  ok(dir, 'describe-proposal', '--summary', 'Add an extra phase', '--assumptions', JSON.stringify(['the base stays as it is']));
}

test('board: progress, needs-you with signal ids, phases folded or open with step marks, within the width', () => {
  const w = world(PHASED);
  try {
    ok(w.dir, 'claim', 'a-one');
    let s = status(w.dir);
    for (const width of [80, 60, 44]) {
      const lines = board(s, { width });
      fits(lines, width);
      const text = lines.join('\n');
      assert.match(text, /0 of 4 done/);
      assert.match(text, /1 in progress/);
      // Base is active: open, with its outcome and a row per job.
      assert.ok(lines.some(l => /▾ Base/.test(l)), text);
      assert.match(text, /The base is laid\./);
      const one = row(lines, 'a-one');
      assert.ok(one, `a row for a-one:\n${text}`);
      assert.match(one, /◐/);
      // claim filled, the rest empty
      assert.equal(stepMarks(one, 'a-one'), '●○○○○', one);
      assert.match(one, /you/, 'who holds it');
      const two = row(lines, 'a-two');
      assert.equal(stepMarks(two, 'a-two'), '○○○○○', two);
      // Later waits: folded to one line that says what it waits for.
      const later = lines.find(l => /Later/.test(l));
      assert.match(later, /▸ Later/);
      assert.match(later, /after base/);
      assert.ok(!row(lines, 'b-one'), 'a folded phase shows no job rows');
      // The step names head the mark columns.
      assert.ok(lines.some(l => /claim\s+test\s+commit\s+push\s+merge/.test(l)), text);
    }
    // Default width is 80.
    fits(board(s), 80);

    // A proposal and an ADR draft need a person: each listed with its signal id.
    propose(w.dir);
    ok(w.dir, 'adr', 'propose', JSON.stringify({ title: 'Plain text only', scope: ['lib/render.mjs'], context: 'Codex has no pane.', decision: 'Render as plain text.', rules: [{ level: 'must', text: 'no ANSI colour codes' }] }));
    s = status(w.dir);
    const sigs = signalsFrom(s);
    assert.equal(sigs.length, 2);
    const lines = board(s, { width: 72 });
    fits(lines, 72);
    const text = lines.join('\n');
    assert.match(text, /Needs you/);
    for (const sig of sigs) assert.ok(text.includes(sig.id), `signal ${sig.id} on the board:\n${text}`);
  } finally { w.done(); }
});

test('board: a plan without phases lists its jobs flat', () => {
  const w = world(FLAT);
  try {
    const lines = board(status(w.dir), { width: 56 });
    fits(lines, 56);
    const text = lines.join('\n');
    assert.match(text, /0 of 2 done/);
    assert.match(text, /1 waiting/);
    assert.match(row(lines, 'first'), /○ first/);
    assert.match(row(lines, 'second'), /… second/);
    assert.match(row(lines, 'second'), /after first/);
    assert.ok(!/[▾▸]/.test(text), 'no phase headings');
  } finally { w.done(); }
});

test('proposal card: new, changed and dropped phases and jobs, warnings, assumptions, then the decide commands', () => {
  const w = world(PHASED);
  try {
    propose(w.dir);
    ok(w.dir, 'propose-phase', JSON.stringify({ id: 'later', title: 'Later on', outcome: 'Built on the base.', after: ['base'] }));
    const s = status(w.dir);
    const sig = signalsFrom(s).find(x => 'proposal' in x.cause);
    assert.ok(sig?.rev, 'a proposal signal with a rev');
    for (const width of [80, 50]) {
      const lines = proposalCard(s, { width });
      fits(lines, width);
      const text = lines.join('\n');
      assert.match(text, /Add an extra phase/, 'headline');
      // The new phase, its jobs beneath with goal, criteria and files.
      const ph = lines.findIndex(l => /\+ .*Extra/.test(l));
      assert.ok(ph >= 0, text);
      const cNew = lines.findIndex(l => /\+ c-new/.test(l));
      assert.ok(cNew > ph, 'c-new under its phase');
      assert.match(text, /Do c-new/);
      assert.match(text, /c-new really works/);
      assert.match(text, /src\/shared\.mjs/);
      // A changed phase and a changed job: field, before → after.
      assert.ok(lines.some(l => /~ .*Later on/.test(l)), text);
      assert.match(text, /~ a-two/);
      assert.match(text.replace(/\n\s*/g, ' '), /goal: Do a-two → Do a-two better/);
      // Dropped, with why.
      assert.match(text, /− b-one/);
      assert.match(text.replace(/\n\s*/g, ' '), /not needed any more/);
      // Warnings and assumptions.
      assert.ok(s.proposal.warnings.length > 0, 'the overlap warns');
      assert.match(text.replace(/\n\s*/g, ' '), /! c-new and c-twin change the same files/);
      assert.match(text, /the base stays as it is/);
      // Last, the exact commands.
      const tail = lines.slice(-3).join('\n');
      assert.ok(tail.includes(`gmod decide ${sig.id} approve --rev ${sig.rev}`), tail);
      assert.ok(tail.includes(`gmod decide ${sig.id} ask-changes --note "`), tail);
      assert.ok(tail.includes(`gmod decide ${sig.id} reject`), tail);
    }
    assert.deepEqual(proposalCard({ ...s, proposal: null }), []);
  } finally { w.done(); }
});

test('decision card: title, context, decision, rules, scope and its commands', () => {
  const w = world(FLAT);
  try {
    ok(w.dir, 'adr', 'propose', JSON.stringify({ title: 'Plain text only', scope: ['lib/render.mjs'], context: 'Codex has no pane.', decision: 'Render as plain text.', rules: [{ level: 'must', text: 'no ANSI colour codes' }, { level: 'should', text: 'wrap long lines' }] }));
    const s = status(w.dir);
    const draft = s.adrDrafts[0];
    const sig = signalsFrom(s).find(x => 'adr' in x.cause);
    const lines = adrCard(draft, sig, { width: 60 });
    fits(lines, 60);
    const text = lines.join('\n');
    assert.match(text, /Plain text only/);
    assert.match(text, /Codex has no pane\./);
    assert.match(text, /Render as plain text\./);
    assert.match(text, /must +no ANSI colour codes/);
    assert.match(text, /should +wrap long lines/);
    assert.match(text, /lib\/render\.mjs/);
    assert.ok(text.includes(`gmod decide ${sig.id} accept`), text);
    assert.ok(text.includes(`gmod decide ${sig.id} reject`), text);
  } finally { w.done(); }
});

test('gmod board prints the board, then any proposal and decision card; --json gives { lines }', () => {
  const w = world(PHASED);
  try {
    let out = ok(w.dir, 'board', '--width', '70');
    fits(out.split('\n'), 70);
    assert.match(out, /0 of 4 done/);
    assert.ok(!/gmod decide/.test(out), 'nothing to decide yet');

    propose(w.dir);
    ok(w.dir, 'adr', 'propose', JSON.stringify({ title: 'Plain text only', scope: [], context: '', decision: 'Render as plain text.', rules: [{ level: 'must', text: 'no ANSI colour codes' }] }));
    const sigs = signalsFrom(status(w.dir));
    out = ok(w.dir, 'board', '--width', '70');
    fits(out.split('\n'), 70);
    const p = sigs.find(x => 'proposal' in x.cause);
    const a = sigs.find(x => 'adr' in x.cause);
    assert.ok(out.includes(`gmod decide ${p.id} approve --rev ${p.rev}`), out);
    assert.ok(out.includes(`gmod decide ${a.id} accept`), out);
    assert.ok(out.indexOf('0 of 4 done') < out.indexOf(`gmod decide ${p.id}`), 'board first');
    assert.match(out, /the whole repository/);

    const j = JSON.parse(ok(w.dir, 'board', '--json', '--width', '70'));
    assert.ok(Array.isArray(j.lines));
    assert.equal(j.lines.join('\n'), out);
    // Default width 80.
    fits(ok(w.dir, 'board').split('\n'), 80);
    assert.match(ok(w.dir, 'help').concat(gmod(w.dir, 'nope').err), /gmod board/);
  } finally { w.done(); }
});

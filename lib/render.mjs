// gmod as plain text: what the pane shows, for hosts with no pane (Codex) and
// for a person at a terminal. Pure functions from the `gmod status` record to
// arrays of lines, each within `width` columns (wrapped, or cut short with …),
// with no colour codes: what colour says in the pane, a mark says here.
//
//   board(status)           progress, what needs a person, the phases and jobs
//   proposalCard(status)    the plan proposal and the commands that decide it
//   adrCard(draft, signal)  a decision draft and the commands that decide it
//
// The folding and the step marks follow the pane (hooks/register.tsx:
// isPhaseOpen, phaseGroup, dots) so both say the same thing.
import { signalsFrom, signalId } from './signals.mjs';

export const WIDTH = 80;
const STEPS = ['claim', 'test', 'commit', 'push', 'merge'];
const ID_MIN = 8;
const ID_MAX = 20;
const NOTE_ROOM = 12;
const BAR = 12;

const len = t => [...t].length;
const widthOf = o => Math.max(20, Math.floor(Number(o?.width) || WIDTH));

// Cut to n columns, … marking the cut.
export function cut(text, n) {
  const chars = [...text];
  if (chars.length <= n) return text;
  if (n <= 0) return '';
  return `${chars.slice(0, n - 1).join('')}…`;
}

// Words into lines of at most `width`: `first` leads the first line, `rest`
// (spaces, usually) the others. A word longer than a line is broken.
export function wrap(text, width, first = '', rest = ' '.repeat(len(first))) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = out.length ? rest : first;
    let lead = len(line);
    let empty = true;
    for (let word of para.split(/\s+/).filter(Boolean)) {
      const room = width - len(line) - (empty ? 0 : 1);
      if (len(word) <= room) {
        line += (empty ? '' : ' ') + word;
        empty = false;
        continue;
      }
      if (!empty) {
        out.push(line);
        line = rest;
        lead = len(rest);
        empty = true;
      }
      // Too long for a whole line: break it.
      while (len(word) > width - lead) {
        const n = Math.max(1, width - lead);
        out.push(line + [...word].slice(0, n).join(''));
        word = [...word].slice(n).join('');
        line = rest;
        lead = len(rest);
      }
      if (word) {
        line += word;
        empty = false;
      }
    }
    out.push(empty && !out.length ? first.trimEnd() : line);
  }
  return out.map(l => cut(l.trimEnd(), width));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The pane's dots, as marks: ● done (or green), ✗ red, ! unproven or failing
// on today's main, ○ not yet.
export function marks(j) {
  const done = j.state === 'done';
  const test = done ? undefined : j.moved?.level === 'breaks' ? 'yellow' : { none: undefined, red: 'red', green: 'green', unproven: 'yellow' }[j.tests];
  const dots = [
    { filled: done || j.stage >= 1 },
    { filled: done || j.tests !== 'none', color: test },
    { filled: j.stage >= 4 },
    { filled: j.stage >= 5 },
    { filled: j.stage >= 6 },
  ];
  return dots.map(d => (!d.filled ? '○' : d.color === 'red' ? '✗' : d.color === 'yellow' ? '!' : '●'));
}

const icon = j => (j.state === 'done' ? '✓' : j.state === 'claimed' ? '◐' : j.state === 'waiting' ? '…' : '○');

// Only what the marks can't say: who has a job, or what it waits for.
function note(j, phases) {
  const phaseWaits = phases.some(ph => ph.id === j.phase && ph.state === 'waiting');
  const moved = j.moved?.level === 'breaks' ? '✗ breaks on main · ' : j.moved?.level === 'conflicts' ? '✗ conflicts · ' : j.moved?.level === 'touched' ? '⚠ main moved · ' : '';
  const who = j.state === 'waiting'
    ? (phaseWaits ? '' : `after ${(j.waiting ?? []).join(', ')}`)
    : j.state === 'claimed' ? (j.where === 'here' ? 'you' : j.where && j.where !== 'elsewhere' ? j.where : (j.by ?? '')) : '';
  return (moved + who).replace(/ · $/, '');
}

// The mark for a signal on the board.
function signalMark(s) {
  if ('proposal' in s.cause) return '◆';
  if ('adr' in s.cause) return '⚖';
  if ('request' in s.cause) return '?';
  return '!';
}

export function board(status, opts = {}) {
  const width = widthOf(opts);
  const s = status ?? {};
  if (!s.governed && !s.proposal) {
    return ['gmod', ...wrap(s.error || 'No plan here yet.', width), ...wrap('Start one with /gmod:plan and say what you want built.', width)];
  }
  const jobs = s.jobs ?? [];
  const phases = s.phases ?? [];
  const p = s.proposal;
  const out = [];

  // Progress.
  const done = jobs.filter(j => j.state === 'done').length;
  const moving = jobs.filter(j => j.state === 'claimed').length;
  const waiting = jobs.filter(j => j.state === 'waiting').length;
  const words = `${done} of ${jobs.length} done${moving ? ` · ${moving} in progress` : ''}${waiting ? ` · ${waiting} waiting` : ''}`;
  if (5 + BAR + 2 + len(words) <= width) {
    const full = jobs.length ? Math.round((done / jobs.length) * BAR) : 0;
    out.push(`Plan ${'━'.repeat(full)}${'┄'.repeat(BAR - full)}  ${words}`);
  } else {
    out.push(...wrap(words, width, 'Plan '));
  }

  // What needs a person, each with its signal id.
  const signals = signalsFrom(s);
  if (signals.length) {
    out.push('', 'Needs you');
    for (const sig of signals) {
      out.push(...wrap(sig.question, width, `${signalMark(sig)} `));
      const card = 'proposal' in sig.cause || 'adr' in sig.cause;
      out.push(...wrap(card ? `signal ${sig.id}: see its card` : `gmod decide ${sig.id} <${sig.actions.join('|')}>`, width, '  '));
    }
  }

  // The jobs, under their phases when the plan has them.
  out.push('');
  if (!jobs.length) {
    out.push('No jobs yet.');
    return out;
  }
  const notes = new Map(jobs.map(j => [j.id, note(j, phases)]));
  const indent = phases.length ? 2 : 0;
  const longestNote = Math.min(NOTE_ROOM, Math.max(0, ...[...notes.values()].map(len)));
  const longestId = Math.max(4, ...jobs.map(j => len(j.id)));
  // Steps two apart when they fit beside the names, else one.
  const stepsWidth = gap => STEPS.reduce((n, name) => n + name.length + gap, 0);
  let gap = 2;
  let idWidth = Math.max(ID_MIN, Math.min(ID_MAX + indent, longestId + indent, width - 3 - stepsWidth(gap) - longestNote));
  if (idWidth + 3 + stepsWidth(gap) + longestNote > width) {
    gap = 1;
    idWidth = Math.max(ID_MIN, Math.min(ID_MAX + indent, longestId + indent, width - 3 - stepsWidth(gap) - longestNote));
  }
  const head = idWidth + 3;

  out.push(cut((' '.repeat(head) + STEPS.map(n => n.padEnd(n.length + gap)).join('')).trimEnd(), width));
  const row = (j, at) => {
    const name = `${' '.repeat(at)}${icon(j)} ${cut(j.id, idWidth - at)}`;
    const dots = marks(j).map((m, i) => (' '.repeat(Math.floor((STEPS[i].length - 1) / 2)) + m).padEnd(STEPS[i].length + gap)).join('');
    const line = name + ' '.repeat(Math.max(1, head - len(name))) + dots;
    const n = notes.get(j.id) ?? '';
    return cut(n ? line + cut(n, Math.max(1, width - len(line))) : line.trimEnd(), width);
  };

  if (!phases.length) {
    for (const j of jobs) out.push(row(j, 0));
    return out;
  }
  // Open where the work is: the active phase, one with a red job or touched
  // by the proposal, else the first that may start.
  const firstReady = phases.find(ph => ph.state === 'ready')?.id;
  const anyActive = phases.some(ph => ph.state === 'active');
  const touched = new Set([...(p?.diff?.added ?? []), ...(p?.diff?.changed ?? [])].map(j => j.phase).filter(Boolean));
  const isOpen = ph => ph.state === 'active' || ph.stalled || touched.has(ph.id) || (!anyActive && ph.id === firstReady);
  for (const ph of phases) {
    const open = isOpen(ph);
    const summary = ph.state === 'done'
      ? `✓ ${ph.done} of ${ph.total}`
      : ph.state === 'waiting' ? `after ${(ph.waiting ?? []).join(', ')}` : `${ph.done} of ${ph.total}${ph.moving ? ` · ${ph.moving} in progress` : ''}`;
    out.push(cut(`${open ? '▾' : '▸'} ${ph.title}  ${summary}${ph.stalled ? ' · ✗ red' : ''}`, width));
    if (!open) continue;
    if (ph.outcome) out.push(...wrap(ph.outcome, width, '  '));
    for (const j of jobs.filter(j => (ph.jobs ?? []).includes(j.id))) out.push(row(j, 2));
  }
  // Jobs no phase holds still show.
  const held = new Set(phases.flatMap(ph => ph.jobs ?? []));
  for (const j of jobs.filter(j => !held.has(j.id))) out.push(row(j, 0));
  return out;
}

const change = (c, width, at) => wrap(`${c.field}: ${c.before} → ${c.after}`, width, ' '.repeat(at), ' '.repeat(at + 2));

export function proposalCard(status, opts = {}) {
  const width = widthOf(opts);
  const p = status?.proposal;
  if (!p) return [];
  const sig = signalsFrom(status).find(x => 'proposal' in x.cause);
  const id = sig?.id ?? signalId({ proposal: p.at });
  const rev = sig?.rev ?? p.rev;
  const d = p.diff ?? {};
  const added = d.added ?? [];
  const changed = d.changed ?? [];
  const dropped = d.dropped ?? [];
  const ph = d.phases ?? { added: [], changed: [], dropped: [] };
  const phases = status.phases ?? [];
  const out = [];

  const title = [
    ph.added.length && plural(ph.added.length, 'new phase'),
    added.length && plural(added.length, 'new job'),
    changed.length + ph.changed.length && `${changed.length + ph.changed.length} changed`,
    dropped.length + ph.dropped.length && `${dropped.length + ph.dropped.length} dropped`,
  ].filter(Boolean).join(', ');
  out.push(...wrap(`Plan change: ${title || 'no changes'}`, width));
  out.push(...wrap(p.headline || 'No summary yet: ask the agent to describe it.', width));
  if (p.by) out.push(...wrap(`proposed by ${p.by}${p.stale ? ' · the plan moved since: look again' : ''}`, width));

  const newJobs = (list, at) => list.flatMap(j => [
    ...wrap(`${j.goal}${j.after?.length ? `  (after ${j.after.join(', ')})` : ''}`, width, `${' '.repeat(at)}+ ${j.id}  `, ' '.repeat(at + 4)),
    ...(j.criteria ?? []).flatMap(c => wrap(c, width, `${' '.repeat(at + 4)}◦ `)),
    ...((j.paths ?? []).length ? wrap(`may change ${j.paths.join(', ')}`, width, ' '.repeat(at + 4)) : []),
  ]);
  const changedJobs = (list, at) => list.flatMap(j => [
    ...wrap(`changes ${(j.fields ?? []).join(', ')}`, width, `${' '.repeat(at)}~ ${j.id}  `, ' '.repeat(at + 4)),
    ...(j.changes ?? []).flatMap(c => change(c, width, at + 4)),
  ]);

  // With phases, jobs sit under the phase they belong to: new phases first,
  // then existing phases that gain or change jobs.
  const grouped = [...new Set([...ph.added.map(x => x.id), ...ph.changed.map(x => x.id), ...[...added, ...changed].map(j => j.phase).filter(Boolean)])];
  const known = new Map([...ph.added, ...ph.changed].map(x => [x.id, x]));
  const titleOf = x => known.get(x)?.title ?? phases.find(y => y.id === x)?.title ?? x;
  for (const pid of grouped) {
    const isNew = ph.added.some(x => x.id === pid);
    const edit = ph.changed.find(x => x.id === pid);
    const card = known.get(pid);
    out.push('');
    const tags = `${card?.after?.length ? `  after ${card.after.map(titleOf).join(', ')}` : ''}${edit ? `  changes ${edit.fields.join(', ')}` : ''}`;
    out.push(...wrap(`${titleOf(pid)}${tags}`, width, `${isNew ? '+' : edit ? '~' : '·'} phase `, '    '));
    if (isNew && card.outcome) out.push(...wrap(card.outcome, width, '    '));
    for (const c of edit?.changes ?? []) out.push(...change(c, width, 4));
    out.push(...newJobs(added.filter(j => j.phase === pid), 2));
    out.push(...changedJobs(changed.filter(j => j.phase === pid), 2));
  }
  const loose = [...newJobs(added.filter(j => !j.phase || !grouped.includes(j.phase)), 0), ...changedJobs(changed.filter(j => !j.phase || !grouped.includes(j.phase)), 0)];
  const gone = [
    ...ph.dropped.flatMap(x => wrap(x.reason ? `why: ${x.reason}` : x.outcome, width, `− phase ${x.title}  `, '    ')),
    ...dropped.flatMap(j => wrap(j.reason ? `why: ${j.reason}` : j.goal, width, `− ${j.id}  `, '    ')),
  ];
  if (loose.length || gone.length) out.push('', ...loose, ...gone);
  if (d.checks?.length) out.push(...wrap(`checks: ${d.checks.join(', ')}`, width));

  if (p.warnings?.length) out.push('', ...p.warnings.flatMap(w => wrap(w, width, '! ')));
  const startNow = (p.order ?? []).filter(o => o.now).length;
  if (startNow > 1 && !(p.warnings ?? []).some(w => /same files/.test(w))) out.push(...wrap(`${startNow} can start now, side by side`, width));
  if (p.assumptions?.length) out.push('', plural(p.assumptions.length, 'assumption'), ...p.assumptions.flatMap(a => wrap(a, width, '· ')));

  // Last, exactly what to run.
  const offered = sig?.actions ?? [...(p.ready ? ['approve'] : []), 'ask-changes', 'reject'];
  out.push('', offered.includes('approve') ? 'Decide (a person):' : 'Decide (a person; not ready to approve yet):');
  const cmd = c => wrap(c, width, '  ', '    ');
  if (offered.includes('approve')) out.push(...cmd(`gmod decide ${id} approve${rev ? ` --rev ${rev}` : ''}`));
  out.push(...cmd(`gmod decide ${id} ask-changes --note "…"`));
  out.push(...cmd(`gmod decide ${id} reject`));
  return out;
}

export function adrCard(draft, signal, opts = {}) {
  const width = widthOf(opts);
  if (!draft) return [];
  const id = signal?.id ?? signalId({ adr: draft.draft });
  const out = [];
  out.push(...wrap(`Decision: ${draft.title}`, width));
  if (draft.context) out.push(...wrap(draft.context, width));
  if (draft.decision) out.push(...wrap(draft.decision, width));
  for (const r of draft.rules ?? []) out.push(...wrap(r.text, width, r.level === 'must' ? '■ must   ' : '□ should '));
  out.push(...wrap(`governs ${draft.scope?.length ? draft.scope.join(', ') : 'the whole repository'}${draft.supersedes ? ` · replaces ADR ${draft.supersedes}` : ''}`, width));
  if (draft.by) out.push(...wrap(`drafted by ${draft.by}`, width));
  out.push('', 'Decide (a person):', ...wrap(`gmod decide ${id} accept`, width, '  ', '    '), ...wrap(`gmod decide ${id} reject`, width, '  ', '    '));
  return out;
}

// The board, then any proposal card and decision cards: what `gmod board` prints.
export function boardWithCards(status, opts = {}) {
  const out = [...board(status, opts)];
  const card = proposalCard(status, opts);
  if (card.length) out.push('', ...card);
  const sigs = signalsFrom(status);
  for (const d of status?.adrDrafts ?? []) {
    out.push('', ...adrCard(d, sigs.find(x => x.cause.adr === d.draft), opts));
  }
  return out;
}

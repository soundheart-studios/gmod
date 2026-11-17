// gmod watch: the person's live plan view in a plain terminal, for hosts with
// no pane (Codex), run in a second terminal or a tmux split beside any agent.
//
// The logic is pure and testable without a terminal:
//   init()                     the starting state
//   sync(state, status)        take in a newly read `gmod status` record
//   step(state, key)           { state, action }: the next state, and at most one
//                              action ({ quit } or { decide: {id, action, rev, note} })
//   view(state, status, width) the lines to draw: lib/render.mjs's board with a
//                              selection and folds, then the card for what is
//                              selected (the waiting proposal by default)
//   act(root, action)          a decision, only ever through lib/decide.mjs with
//                              via 'watch' and the rev that was on screen, so a
//                              proposal that changed since is refused, and so is
//                              anything under an agent's environment (ADR 0003)
// run() is the terminal loop: it only reads keys, reads gmod, and writes lines.
import * as core from './core.mjs';
import { decide } from './decide.mjs';
import { board, proposalCard, adrCard, wrap, cut } from './render.mjs';
import { signalsFrom } from './signals.mjs';
import { stamp } from './stamp.mjs';

const STEPS = /^\s+claim\s+test\s+commit/;
const MARK = '› ';
const PAD = '  ';

export function init() {
  return { at: null, folds: {}, opened: {}, note: null, message: '', signals: [], phases: [], loose: [], defaults: {} };
}

// What can be selected, from the status record: signals, phases and jobs.
export function sync(state, status) {
  const s = status ?? {};
  const signals = signalsFrom(s).map(x => ({ id: x.id, kind: x.kind, rev: x.rev, actions: x.actions, cause: x.cause }));
  const phases = (s.phases ?? []).map(ph => ({ id: ph.id, jobs: (s.jobs ?? []).filter(j => (ph.jobs ?? []).includes(j.id)).map(j => j.id) }));
  const held = new Set(phases.flatMap(ph => ph.jobs));
  const loose = (s.jobs ?? []).filter(j => !held.has(j.id)).map(j => j.id);
  // Which phases the board opens by itself: as lib/render.mjs folds them.
  const defaults = {};
  if (phases.length && (s.jobs ?? []).length) {
    const heads = board(s, { width: 400 }).filter(l => /^[▾▸] /.test(l));
    phases.forEach((ph, i) => { defaults[ph.id] = heads[i]?.startsWith('▾') ?? false; });
  }
  return { ...state, signals, phases, loose, defaults };
}

const isOpen = (state, id) => state.folds[id] ?? state.defaults[id] ?? false;

// Every selectable item, in the order drawn.
function items(state) {
  const out = state.signals.map(x => `signal:${x.id}`);
  for (const ph of state.phases) {
    out.push(`phase:${ph.id}`);
    if (isOpen(state, ph.id)) out.push(...ph.jobs.map(j => `job:${j}`));
  }
  out.push(...state.loose.map(j => `job:${j}`));
  return out;
}

const current = state => {
  const list = items(state);
  return list.includes(state.at) ? state.at : list[0] ?? null;
};

const signalAt = (state, at) => (at?.startsWith('signal:') ? state.signals.find(x => x.id === at.slice(7)) : null);

const decision = (sig, action, note) => ({ decide: { id: sig.id, action, rev: sig.rev, ...(note !== undefined ? { note } : {}) } });

export function step(state, key) {
  const none = s => ({ state: s, action: null });
  if (key === 'ctrl-c') return { state, action: { quit: true } };

  // Typing a note: for ask-changes, or an answer to a request.
  if (state.note) {
    const n = state.note;
    if (key === 'escape') return none({ ...state, note: null, message: '' });
    if (key === 'backspace') return none({ ...state, note: { ...n, text: [...n.text].slice(0, -1).join('') } });
    if (key === 'enter') {
      const text = n.text.trim();
      if (!text) return none({ ...state, message: 'type something first, or esc to cancel' });
      const sig = state.signals.find(x => x.id === n.id);
      if (!sig) return none({ ...state, note: null, message: 'that is no longer waiting' });
      return { state: { ...state, note: null, message: '' }, action: decision(sig, n.action, text) };
    }
    if ([...key].length === 1 && key >= ' ') return none({ ...state, note: { ...n, text: n.text + key } });
    return none(state);
  }

  const at = current(state);
  const list = items(state);
  const i = list.indexOf(at);
  if (key === 'q') return { state, action: { quit: true } };
  if (key === 'down' || key === 'j') return none({ ...state, at: list[Math.min(list.length - 1, i + 1)] ?? null, message: '' });
  if (key === 'up' || key === 'k') return none({ ...state, at: list[Math.max(0, i - 1)] ?? null, message: '' });

  const sig = signalAt(state, at);
  if (key === 'enter') {
    if (at?.startsWith('phase:')) {
      const id = at.slice(6);
      return none({ ...state, at, folds: { ...state.folds, [id]: !isOpen(state, id) } });
    }
    if (at?.startsWith('job:')) {
      const id = at.slice(4);
      return none({ ...state, at, opened: { ...state.opened, [id]: !state.opened[id] } });
    }
    if (sig?.actions.includes('answer')) return none({ ...state, at, note: { id: sig.id, action: 'answer', text: '' } });
    return none(state);
  }
  if (!sig) return none(state);
  if (key === 'a') {
    if (sig.actions.includes('approve')) return { state: { ...state, at }, action: decision(sig, 'approve') };
    if (sig.actions.includes('accept')) return { state: { ...state, at }, action: decision(sig, 'accept') };
    if (sig.actions.includes('answer')) return none({ ...state, at, note: { id: sig.id, action: 'answer', text: '' } });
    if ('proposal' in sig.cause) return none({ ...state, message: 'not ready to approve yet: ask for changes or reject' });
  }
  if (key === 'c' && sig.actions.includes('ask-changes')) return none({ ...state, at, note: { id: sig.id, action: 'ask-changes', text: '' } });
  if (key === 'r' && sig.actions.includes('reject')) return { state: { ...state, at }, action: decision(sig, 'reject') };
  return none(state);
}

const critMark = c => (c.pass === true ? '✓' : c.pass === false ? '✗' : '◦');

// What an opened job shows under its row.
function details(j, width, at) {
  const lead = ' '.repeat(at);
  const out = [...wrap(j.goal ?? '', width, lead)];
  for (const c of j.criteria ?? []) out.push(...wrap(c.text, width, `${lead}${critMark(c)} `));
  if (j.files?.length) out.push(...wrap(`may change ${j.files.join(', ')}`, width, lead));
  for (const n of (j.journal ?? []).slice(-3)) out.push(...wrap(`${n.by}: ${n.text}`, width, `${lead}· `, `${lead}  `));
  return out;
}

// The board as lib/render.mjs draws it, with this view's folds: each line
// tagged with the item it starts (or null).
function boardLines(state, status, width) {
  const real = board(status, { width });
  const jobs = status?.jobs ?? [];
  const head = real.findIndex(l => STEPS.test(l));
  if (head < 0) return real.map(text => ({ text, item: null }));
  const out = [];
  // Signals in "Needs you": each starts with its mark, unindented.
  const needs = real.indexOf('Needs you');
  let n = 0;
  real.slice(0, head + 1).forEach((text, k) => {
    const isSig = needs >= 0 && k > needs && text && !text.startsWith(' ') && n < state.signals.length;
    out.push({ text, item: isSig ? `signal:${state.signals[n++].id}` : null });
  });
  const byId = new Map(jobs.map(j => [j.id, j]));
  const jobRow = (text, id, at) => {
    out.push({ text, item: `job:${id}` });
    if (state.opened[id] && byId.get(id)) for (const d of details(byId.get(id), width, at + 4)) out.push({ text: d, item: null });
  };

  if (!state.phases.length) {
    real.slice(head + 1).forEach((text, k) => (state.loose[k] ? jobRow(text, state.loose[k], 0) : out.push({ text, item: null })));
    return out;
  }
  // Every phase open, so each phase's rows are there to show or hide: a
  // proposal that touches every phase opens them all in lib/render.mjs.
  const p = status.proposal ?? {};
  const all = { ...status, proposal: { ...p, diff: { ...(p.diff ?? {}), added: [...(p.diff?.added ?? []), ...state.phases.map(ph => ({ phase: ph.id }))] } } };
  const full = board(all, { width });
  let k = full.findIndex(l => STEPS.test(l)) + 1;
  for (const ph of state.phases) {
    const outcome = (status.phases ?? []).find(x => x.id === ph.id)?.outcome;
    const open = isOpen(state, ph.id);
    const header = full[k++] ?? '';
    out.push({ text: open ? header : header.replace(/^▾/, '▸'), item: `phase:${ph.id}` });
    const lines = outcome ? wrap(outcome, width, '  ').length : 0;
    if (open) for (const text of full.slice(k, k + lines)) out.push({ text, item: null });
    k += lines;
    for (const id of ph.jobs) {
      const text = full[k++] ?? '';
      if (open) jobRow(text, id, 2);
    }
  }
  for (const id of state.loose) jobRow(full[k++] ?? '', id, 0);
  return out;
}

// The card under the board: the selected signal's, else the waiting proposal's.
function card(state, status, width, at) {
  const sig = signalAt(state, at);
  const sigs = signalsFrom(status);
  if (sig && 'adr' in sig.cause) return adrCard((status.adrDrafts ?? []).find(d => d.draft === sig.cause.adr), sigs.find(x => x.id === sig.id), { width });
  if (sig && !('proposal' in sig.cause)) {
    const full = sigs.find(x => x.id === sig.id);
    return [...wrap(full?.question ?? '', width), ...(full?.detail ? wrap(full.detail, width) : [])];
  }
  const p = proposalCard(status, { width });
  if (p.length) return p;
  const d = status?.adrDrafts?.[0];
  return d ? adrCard(d, sigs.find(x => x.cause.adr === d.draft), { width }) : [];
}

function keys(state, at) {
  const sig = signalAt(state, at);
  const words = ['↑↓ move'];
  if (at?.startsWith('phase:') || at?.startsWith('job:')) words.push('enter open/fold');
  if (sig?.actions.includes('approve')) words.push('a approve');
  if (sig?.actions.includes('accept')) words.push('a accept');
  if (sig?.actions.includes('answer')) words.push('a answer');
  if (sig?.actions.includes('ask-changes')) words.push('c ask for changes');
  if (sig?.actions.includes('reject')) words.push('r reject');
  words.push('q quit');
  return words.join(' · ');
}

export function view(state, status, width = 80) {
  const w = Math.max(20, width - MARK.length);
  const at = current(state);
  const out = boardLines(state, status, w).map(l => (l.item && l.item === at ? MARK : PAD) + l.text);
  const c = card(state, status, w, at);
  if (c.length) out.push('', ...c.map(l => PAD + l));
  out.push('');
  if (state.note) {
    const what = state.note.action === 'answer' ? 'answer' : 'what to change';
    out.push(...wrap(`${what}: ${state.note.text}▏`, width), cut('enter send · esc cancel', width));
  } else {
    out.push(cut(keys(state, at), width));
  }
  if (state.message) out.push(...wrap(state.message, width));
  return out;
}

// A decision from the view: gmod decide, via watch, with the rev on screen.
export async function act(root, action, { env = process.env } = {}) {
  const d = action.decide;
  return decide(root, d.id, d.action, { rev: d.rev, note: d.note, via: 'watch', env });
}

// Raw terminal input as key names.
export function keysOf(data) {
  const out = [];
  const s = String(data);
  for (let i = 0; i < s.length; i++) {
    const rest = s.slice(i);
    const seq = [['\x1b[A', 'up'], ['\x1bOA', 'up'], ['\x1b[B', 'down'], ['\x1bOB', 'down']].find(([q]) => rest.startsWith(q));
    if (seq) { out.push(seq[1]); i += seq[0].length - 1; continue; }
    if (rest.startsWith('\x1b[')) { // another sequence: skip it
      const m = rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
      i += (m ? m[0].length : 2) - 1;
      continue;
    }
    const ch = s[i];
    if (ch === '\x1b') out.push('escape');
    else if (ch === '\r' || ch === '\n') out.push('enter');
    else if (ch === '\x7f' || ch === '\b') out.push('backspace');
    else if (ch === '\x03') out.push('ctrl-c');
    else if (ch >= ' ') out.push(ch);
  }
  return out;
}

// The terminal loop: redraw when the stamp changes (looked at every second),
// sync with origin every 30 seconds. `after(result)` publishes a decision.
export function run(root, { input = process.stdin, output = process.stdout, after = async () => [] } = {}) {
  return new Promise(resolveRun => {
    let state = init();
    let status = core.status(root, { sync: true });
    let seen = stamp(root);
    let busy = false;
    state = sync(state, status);

    const draw = () => {
      const width = output.columns || 80;
      const rows = output.rows || 24;
      let lines = view(state, status, width);
      if (lines.length > rows) {
        const sel = Math.max(0, lines.findIndex(l => l.startsWith(MARK)));
        const top = Math.max(0, Math.min(sel - Math.floor(rows / 3), lines.length - rows));
        lines = lines.slice(top, top + rows);
      }
      output.write(`\x1b[H\x1b[2J${lines.join('\r\n')}`);
    };
    const reload = (sync_ = false) => {
      try {
        status = core.status(root, { sync: sync_ });
        state = sync(state, status);
      } catch (e) {
        state = { ...state, message: e.message };
      }
      seen = stamp(root);
      draw();
    };

    const tick = setInterval(() => {
      if (busy) return;
      if (stamp(root) !== seen) reload();
    }, 1000);
    const fetch = setInterval(() => !busy && reload(true), 30000);

    const quit = () => {
      clearInterval(tick);
      clearInterval(fetch);
      input.off('data', onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      resolveRun(0);
    };
    async function onData(data) {
      if (busy) return;
      for (const key of keysOf(data)) {
        const r = step(state, key);
        state = r.state;
        if (r.action?.quit) return quit();
        if (r.action?.decide) {
          busy = true;
          state = { ...state, message: `${r.action.decide.action}…` };
          draw();
          try {
            const res = await act(root, r.action);
            const lines = res.decided ? await after(res) : [];
            state = { ...state, message: res.decided ? [`${res.action}: done (by ${res.by}, via watch)`, ...lines].join(' · ') : `not a decision: ${res.hint}` };
          } catch (e) {
            if (!(e instanceof core.GmodError)) throw e;
            state = { ...state, message: e.message };
          } finally {
            busy = false;
          }
          return reload();
        }
      }
      draw();
    }

    output.write('\x1b[?1049h\x1b[?25l');
    if (input.isTTY) input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
    output.on?.('resize', draw);
    draw();
  });
}

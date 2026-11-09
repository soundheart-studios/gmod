// gmod signals: what needs a person, for the pane's "Needs you" and for faces
// (Skiff) that read gmod without the pane. Computed from the status record
// `gmod status` prints, never stored: a cause that is resolved simply isn't
// computed any more. Each signal's id is a hash of its cause, so the same
// cause keeps its id from run to run. The shape is protocol v1, as Skiff's
// recorded fixtures define it:
//   { v, id, rev?, kind: decide|unstick|know, project, question, detail, cause, evidence, actions, at }
//
// No imports: the mod's hook draws the pane from this same module.

export const SIGNALS_VERSION = 1;

// FNV-1a, 32 bits, as 8 hex digits: short, stable, and the same everywhere.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The cause, keys sorted, so the id never depends on the order they were written in.
const idOf = cause => hash(JSON.stringify(Object.keys(cause).sort().map(k => [k, cause[k]])));

const where = j => (j.where && j.where !== 'here' ? j.where : '');

function signal(project, fields) {
  const s = { v: SIGNALS_VERSION, id: idOf(fields.cause), kind: fields.kind };
  // The version of what it asks about (a proposal's content): changes on
  // every edit while the id stays. Additive to protocol v1.
  if (fields.rev) s.rev = fields.rev;
  if (project) s.project = project;
  s.question = fields.question;
  if (fields.detail) s.detail = fields.detail;
  s.cause = fields.cause;
  s.evidence = fields.evidence ?? [];
  s.actions = fields.actions ?? [];
  if (fields.at) s.at = fields.at;
  return s;
}

// What needs a person, in the pane's order: the plan proposal, decision
// drafts, jobs whose criteria still fail, then jobs main moved under.
export function signalsFrom(status, { project } = {}) {
  if (!status) return [];
  const out = [];
  const p = status.proposal;
  if (p) {
    out.push(signal(project, {
      kind: 'decide',
      cause: { proposal: p.at },
      rev: p.rev,
      question: `Plan change waiting for you: ${p.headline || p.summary || 'no summary yet'}`,
      detail: [p.summary && p.headline ? p.summary : '', ...(p.warnings ?? []).map(w => `! ${w}`)].filter(Boolean).join('\n') || undefined,
      evidence: ['proposal/plan'],
      actions: [...(p.ready ? ['approve'] : []), 'ask-changes', 'reject'],
      at: p.at,
    }));
  }
  for (const d of status.adrDrafts ?? []) {
    out.push(signal(project, {
      kind: 'decide',
      cause: { adr: d.draft },
      question: `Decision waiting: ${d.title}`,
      detail: d.decision,
      evidence: [`adr-draft/${d.draft}`],
      actions: ['accept', 'reject'],
    }));
  }
  const jobs = status.jobs ?? [];
  for (const j of jobs.filter(j => j.stalled)) {
    out.push(signal(project, {
      kind: 'unstick',
      cause: { stuck: j.id },
      question: `${j.id} is red${where(j) ? ` in ${where(j)}` : ''}: its criteria still fail`,
      detail: (j.criteria ?? []).filter(c => c.pass === false).map(c => `✗ ${c.text}`).join('\n') || undefined,
      evidence: [`journal/${j.id}.md`],
      actions: ['open'],
      at: [...(j.journal ?? [])].reverse().find(n => n.by === 'check')?.at,
    }));
  }
  for (const j of jobs.filter(j => j.moved && ['conflicts', 'breaks'].includes(j.moved.level))) {
    const m = j.moved;
    const what = m.level === 'breaks'
      ? ` fails on today's main: ${m.landed.join(', ') || 'main'} changed ${(m.touched.length ? m.touched : m.changed).slice(0, 3).join(', ')}`
      : ` conflicts with main in ${m.conflicts.join(', ')}`;
    out.push(signal(project, {
      kind: 'unstick',
      cause: { moved: j.id, level: m.level },
      question: `${j.id}${what}${where(j) ? ` (${where(j)})` : ''}: rebase onto main`,
      detail: m.failing?.length ? m.failing.map(c => `✗ ${c}`).join('\n') : undefined,
      evidence: [`journal/${j.id}.md`, ...m.landed.map(l => `job/${l}`)],
      actions: ['rebase'],
    }));
  }
  return out;
}

// The pane's line for a signal, word for word as it always read; null for the
// proposal, which the pane draws as its card.
export function paneLine(s) {
  if ('proposal' in s.cause) return null;
  if ('adr' in s.cause) return `⚖ ${s.question}`;
  return `! ${s.question}`;
}

// The list in words, for a person at a terminal.
export function describe(list) {
  if (!list.length) return 'nothing needs you';
  return list.map(s => `${s.kind.padEnd(8)} ${s.question}${s.detail ? `\n         ${s.detail.replace(/\n/g, '\n         ')}` : ''}`).join('\n');
}

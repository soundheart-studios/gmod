// Requests: an agent asks the person a question about its job, and the person
// answers (E5). Shared like a proposal (ADR 0002): each lives at
// refs/gmod/requests/<id>, pushed to origin, so every clone, the pane, the
// CLI and Skiff show the same one under the same id. Open requests are
// signals (lib/signals.mjs) with the actions answer and resolve; only a person
// takes them (lib/decide.mjs). An answered or resolved request stays readable
// (`gmod requests --all`) until its job is done, so a fresh agent on the job
// can read the answer; the asking worktree's notice tells it once.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GmodError, current, stateDir, syncClaims, who } from './core.mjs';
import * as shared from './shared.mjs';
import { bump } from './stamp.mjs';

export const REQUESTS = 'refs/gmod/requests/';
const FILE = 'request.json';

const read = (root, ref) => shared.readJson(root, ref, FILE);
export const isOpen = r => !!r && r.answer == null && !r.resolved;

// Every request this clone knows, oldest first; open ones only unless `all`.
export function requests(root, { all = false, job } = {}) {
  return Object.keys(shared.refsUnder(root, REQUESTS))
    .map(ref => read(root, ref))
    .filter(r => r && (all || isOpen(r)) && (!job || r.job === job))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export function request(root, id) {
  return read(root, REQUESTS + id);
}

// Raise a request for the job claimed here.
export function ask(root, question, { options } = {}) {
  const mine = current(root);
  if (!mine) throw new GmodError('ask about a job you have claimed: nothing is claimed here (gmod claim <job>)');
  const text = String(question ?? '').trim();
  if (!text) throw new GmodError('gmod ask <question>: say what you need to know');
  if (options !== undefined && (!Array.isArray(options) || !options.length || options.some(o => typeof o !== 'string' || !o.trim()))) {
    throw new GmodError('--options takes a JSON list of answers, e.g. \'["cents","floats"]\'');
  }
  const at = new Date().toISOString();
  const id = createHash('sha256').update(`${mine.job}\0${text}\0${at}`).digest('hex').slice(0, 12);
  const r = { id, job: mine.job, question: text, ...(options ? { options } : {}), by: who(root), at };
  syncClaims(root);
  if (!shared.writeJson(root, REQUESTS + id, FILE, r)) throw new GmodError('the request was written a moment ago: ask again');
  shared.publish(root, REQUESTS + id);
  bump(root);
  return r;
}

// The person's answer, or closing it without one. Read again and retried if
// someone else wrote it meanwhile.
function close(root, id, change) {
  for (let i = 0; i < 8; i++) {
    syncClaims(root);
    const ref = REQUESTS + id;
    const r = read(root, ref);
    if (!r) throw new GmodError(`no request ${id}`);
    if (!isOpen(r)) throw new GmodError(`request ${id} is already ${r.resolved ? 'resolved' : 'answered'}`);
    const next = { ...r, ...change(r) };
    if (!shared.writeJson(root, ref, FILE, next)) continue;
    if (shared.publish(root, ref) === 'race') continue;
    bump(root);
    return next;
  }
  throw new GmodError(`request ${id} keeps changing: look at it again`);
}

export function answer(root, id, note, { via = 'cli' } = {}) {
  const text = String(note ?? '').trim();
  if (!text) throw new GmodError('answer with --note <your answer>');
  return close(root, id, r => {
    if (r.options?.length && !r.options.includes(text)) throw new GmodError(`answer with one of the options: ${r.options.join(', ')}`);
    return { answer: text, answeredBy: who(root), answeredAt: new Date().toISOString(), via };
  });
}

export function resolve(root, id, note = '', { via = 'cli' } = {}) {
  return close(root, id, () => ({ resolved: true, ...(note ? { note } : {}), answeredBy: who(root), answeredAt: new Date().toISOString(), via }));
}

// For the worktree that asked: answers to its job's requests it hasn't been
// told yet, once each.
const toldFile = root => join(stateDir(root), 'told-requests.json');

export function untold(root) {
  const mine = current(root);
  if (!mine) return [];
  const f = toldFile(root);
  let told = [];
  try { told = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []; } catch { /* start over */ }
  const fresh = requests(root, { all: true, job: mine.job }).filter(r => !isOpen(r) && !told.includes(r.id));
  if (fresh.length) writeFileSync(f, JSON.stringify([...told, ...fresh.map(r => r.id)].slice(-200)));
  return fresh;
}

// Requests of jobs done on main tell nobody anything any more.
export function sweepRequests(root, done) {
  for (const ref of Object.keys(shared.refsUnder(root, REQUESTS))) {
    const r = read(root, ref);
    if (r && done.has(r.job)) shared.dropOver(root, ref);
  }
}

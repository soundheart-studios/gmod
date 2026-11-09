// gmod core: everything the mod, a person at a terminal and CI share.
// Zero dependencies: node >= 20 and git.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { adrDir, applicable, carryOverDrafts, drafts as adrDrafts, listAdrs } from './adr.mjs';
import { requests as openRequests, sweepRequests, untold } from './requests.mjs';
import { bump, bumpIfRefsMove } from './stamp.mjs';
import * as shared from './shared.mjs';

export const PLAN = '.gmod/plan.json';
// Managed mode's switch (lib/managed.mjs names it too; that module imports this one).
export const MANAGED_SWITCH = '.gmod/managed.json';
const CLAIMS = 'refs/gmod/claims/';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ID = /^[a-z0-9][a-z0-9._-]*$/;

export class GmodError extends Error {}

// ---------- git ----------

export function git(args, { cwd, input, env, allow = false } = {}) {
  const r = spawnSync('git', args, { cwd, input, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0 && !allow) throw new GmodError(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return allow ? { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } : r.stdout.trim();
}

export function repoRoot(cwd = process.cwd()) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd, allow: true });
  if (!r.ok) throw new GmodError('not inside a git repository');
  return r.out;
}

// While board() reads, each worktree's gmod folder is looked up once: the
// same answer would otherwise be asked of git for the claim, the evidence
// and the moved check. Outside a read it is asked fresh every time.
let stateDirs = null;

export function stateDir(root) {
  const known = stateDirs?.get(root);
  if (known) return known;
  const dir = resolve(root, git(['rev-parse', '--git-dir'], { cwd: root }), 'gmod');
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  stateDirs?.set(root, dir);
  return dir;
}

function hasOrigin(root) {
  return git(['remote', 'get-url', 'origin'], { cwd: root, allow: true }).ok;
}

export function who(root) {
  const email = git(['config', 'user.email'], { cwd: root, allow: true }).out;
  return email || git(['config', 'user.name'], { cwd: root, allow: true }).out || process.env.USER || 'unknown';
}

// ---------- plan ----------

export function parsePlan(text, where = PLAN) {
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (e) {
    throw new GmodError(`${where} isn't valid JSON: ${e.message}`);
  }
  const problems = validatePlan(plan);
  if (problems.length) throw new GmodError(`${where}:\n  - ${problems.join('\n  - ')}`);
  return plan;
}

export function validatePlan(plan, { draft = false } = {}) {
  const p = [];
  if (!plan || typeof plan !== 'object') return ['the plan must be an object'];
  const checks = plan.checks ?? {};
  const jobs = Array.isArray(plan.jobs) ? plan.jobs : (p.push('"jobs" must be a list'), []);
  const ids = new Set();
  for (const [i, j] of jobs.entries()) {
    const at = `job ${j?.id ?? `#${i + 1}`}`;
    if (!ID.test(j?.id ?? '')) p.push(`${at}: "id" must be lowercase letters, digits, . _ -`);
    if (ids.has(j.id)) p.push(`${at}: the id is used twice`);
    ids.add(j.id);
    if (!j.goal) p.push(`${at}: needs a "goal"`);
    if (!Array.isArray(j.files) || !j.files.length) p.push(`${at}: needs "files", the globs it may change`);
    if (!Array.isArray(j.done_when) || !j.done_when.length) p.push(`${at}: needs "done_when", at least one criterion`);
    for (const c of j.done_when ?? []) {
      if (!c.text) p.push(`${at}: every "done_when" entry needs "text"`);
      if (!c.check) p.push(`${at}: "${c.text}" needs a "check"`);
      else if (!checks[c.check]) p.push(`${at}: check "${c.check}" isn't defined under "checks"`);
    }
  }
  for (const j of jobs) for (const d of j.after ?? []) if (!ids.has(d)) p.push(`job ${j.id}: "after" names unknown job ${d}`);

  // Contracts: files other jobs build on (a schema, migrations). A change to
  // one tells every job in flight, wherever it works.
  if (plan.contracts !== undefined && (!Array.isArray(plan.contracts) || plan.contracts.some(c => typeof c !== 'string'))) {
    p.push('"contracts" must be a list of globs');
  }
  // Teardown: what undoes the checks' outside effects (a cluster, a
  // container), run in a throwaway checkout before gmod removes it.
  if (plan.teardown !== undefined && (typeof plan.teardown !== 'string' || !plan.teardown.trim())) {
    p.push('"teardown" must be a shell command');
  }

  // Phases: groups of jobs with an outcome, ordered among themselves. When a
  // plan has phases, every job belongs to one.
  const phases = plan.phases ?? [];
  if (!Array.isArray(phases)) return [...p, '"phases" must be a list'];
  const pids = new Set();
  for (const [i, ph] of phases.entries()) {
    const at = `phase ${ph?.id ?? `#${i + 1}`}`;
    if (!ID.test(ph?.id ?? '')) p.push(`${at}: "id" must be lowercase letters, digits, . _ -`);
    if (pids.has(ph.id)) p.push(`${at}: the id is used twice`);
    pids.add(ph.id);
    if (!ph.outcome) p.push(`${at}: needs an "outcome", one sentence of what is true once it's done`);
  }
  for (const ph of phases) for (const d of ph.after ?? []) if (!pids.has(d)) p.push(`phase ${ph.id}: "after" names unknown phase ${d}`);
  for (const j of jobs) if (j.phase && !pids.has(j.phase)) p.push(`job ${j.id}: "phase" names unknown phase ${j.phase}`);
  // A draft is built a step at a time: these hold once it's approved.
  if (!draft) p.push(...unfinished(plan));
  if (!p.length) {
    const loop = cycle(plan);
    if (loop) p.push(`the order goes in a circle: ${loop.join(' → ')}`);
  }
  return p;
}

// What a plan still lacks before it can be approved: in a plan with
// phases, every job in one, and no phase empty.
export function unfinished(plan) {
  const phases = plan.phases ?? [];
  if (!phases.length) return [];
  return [
    ...plan.jobs.filter(j => !j.phase).map(j => `job ${j.id} isn't in a phase yet`),
    ...phases.filter(ph => !plan.jobs.some(j => j.phase === ph.id)).map(ph => `phase ${ph.id} has no jobs yet`),
  ];
}

// What a job waits for: the jobs it names, and every job of the phases its
// own phase comes after.
export function waitsOn(plan, j) {
  const out = new Set(j.after ?? []);
  const ph = (plan.phases ?? []).find(x => x.id === j.phase);
  for (const before of ph?.after ?? []) for (const o of plan.jobs) if (o.phase === before) out.add(o.id);
  return [...out];
}

function cycle(plan) {
  const state = new Map();
  const path = [];
  const visit = id => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'open');
    path.push(id);
    const j = plan.jobs.find(x => x.id === id);
    for (const d of j ? waitsOn(plan, j) : []) {
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const j of plan.jobs) {
    const found = visit(j.id);
    if (found) return found;
  }
  return null;
}

export function planFromDisk(root) {
  const file = join(root, PLAN);
  if (!existsSync(file)) return null;
  return parsePlan(readFileSync(file, 'utf8'));
}

export function planAt(root, ref) {
  const r = git(['show', `${ref}:${PLAN}`], { cwd: root, allow: true });
  return r.ok ? parsePlan(r.out, `${PLAN} at ${ref.slice(0, 12)}`) : null;
}

function job(plan, id) {
  const j = plan.jobs.find(x => x.id === id);
  if (!j) throw new GmodError(`no job "${id}" in the plan`);
  return j;
}

// ---------- globs ----------

export function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const matches = (globs, path) => (globs ?? []).some(g => globRe(g).test(path));
const allowed = (j, path) => matches(j.files, path) || matches(j.tests, path);

// ---------- done, claims, states ----------

function mainRef(root, plan) {
  const main = plan.main ?? 'main';
  for (const ref of [`refs/remotes/origin/${main}`, `refs/heads/${main}`]) {
    if (git(['rev-parse', '-q', '--verify', ref], { cwd: root, allow: true }).ok) return ref;
  }
  return 'HEAD';
}

// A job is done once its id leads a commit subject on main ("<job>: …"),
// as a squash-merged pull request titled that way leaves it.
export function doneJobs(root, ref) {
  const subjects = git(['log', '--format=%s', ref], { cwd: root, allow: true }).out.split('\n');
  const done = new Set();
  for (const s of subjects) {
    const m = s.match(/^([a-z0-9][a-z0-9._-]*):/);
    if (m) done.add(m[1]);
  }
  return done;
}

// Claims and the shared records (ADR 0002) come in one fetch; each shared
// record is then brought in line with origin's (lib/shared.mjs).
// Each name is a prefix: 'proposal' is refs/gmod/proposal, 'adr-drafts/'
// every refs/gmod/adr-drafts/<slug>, 'runs/' every job's latest verdict.
const SHARED_NAMES = ['proposal', 'adr-drafts/', 'runs/', 'requests/'];

export function syncClaims(root) {
  carryOverProposal(root);
  carryOverDrafts(root);
  if (!hasOrigin(root)) {
    if (landed(root, rawProposal(root))) git(['update-ref', '-d', PROPOSAL], { cwd: root, allow: true });
    return false;
  }
  return bumpIfRefsMove(root, () => {
    const before = Object.fromEntries(SHARED_NAMES.map(n => [n, shared.seenUnder(root, n)]));
    // A landed proposal left here isn't an edit to push: let it go first.
    if (landed(root, rawProposal(root))) git(['update-ref', '-d', PROPOSAL], { cwd: root, allow: true });
    const ok = git(['fetch', '-q', '--prune', 'origin', `+${CLAIMS}*:${CLAIMS}*`, ...SHARED_NAMES.map(shared.fetchSpec)], { cwd: root, allow: true }).ok;
    if (ok) for (const n of SHARED_NAMES) shared.reconcileUnder(root, n, before[n]);
    // Back on origin too (pushed by a clone that kept a copy): take it down.
    if (ok && landed(root, rawProposal(root))) shared.unpublish(root, PROPOSAL);
    return ok;
  });
}

export function claims(root) {
  const out = git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(contents)%01', CLAIMS], { cwd: root });
  const list = {};
  for (const row of out.split('\x01')) {
    const [ref, obj, body] = row.trim().split('\0');
    if (!ref) continue;
    let info = {};
    try { info = JSON.parse(body); } catch { /* a claim we can't read still holds the job */ }
    list[ref.slice(CLAIMS.length)] = { ...info, obj };
  }
  return list;
}

export function states(root, plan, { sync = true } = {}) {
  if (sync) syncClaims(root);
  const done = doneJobs(root, mainRef(root, plan));
  const held = claims(root);
  return plan.jobs.map(j => {
    const waiting = waitsOn(plan, j).filter(d => !done.has(d));
    const state = done.has(j.id) ? 'done' : held[j.id] ? 'claimed' : waiting.length ? 'waiting' : 'ready';
    return { id: j.id, goal: j.goal, state, by: held[j.id]?.by, waiting, after: j.after ?? [] };
  });
}

export function next(root, plan) {
  return states(root, plan).find(s => s.state === 'ready') ?? null;
}

// Claims on jobs that are done on main are let go (CI runs this on main).
export function sweep(root) {
  const plan = planFromDisk(root);
  if (!plan) return [];
  syncClaims(root);
  const done = doneJobs(root, mainRef(root, plan));
  const swept = Object.keys(claims(root)).filter(id => done.has(id));
  for (const id of swept) release(root, id);
  // Verdicts of jobs done on main tell nobody anything any more.
  for (const ref of Object.keys(shared.refsUnder(root, RUNS))) {
    if (done.has(ref.slice(RUNS.length))) shared.dropOver(root, ref);
  }
  sweepRequests(root, done);
  return swept;
}

// ---------- local state: the claim this worktree works, its evidence ----------

const claimFile = root => join(stateDir(root), 'claim.json');

export function current(root) {
  const f = claimFile(root);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

function evidenceFile(root, id) {
  return join(stateDir(root), 'evidence', `${id}.json`);
}

export function evidence(root, id) {
  const f = evidenceFile(root, id);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}

// Which checks a run ran: the job's criteria and their commands. A run under
// other checks proves nothing about these (a red from a check that couldn't
// even start, fixed since, isn't a red of the code).
export function checksKey(plan, j) {
  const spec = j.done_when.map(c => [c.text, c.check, plan.checks?.[c.check] ?? null]);
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
}

// The runs that count for a job now: since its claim, under today's checks.
export function proof(root, plan, id, since) {
  const j = plan.jobs.find(x => x.id === id);
  if (!j) return [];
  const key = checksKey(plan, j);
  return evidence(root, id).filter(r => (!since || r.at >= since) && r.checks === key);
}

// ---------- main moved under you ----------
//
// Each job started from some point of main. When main moves past it, how much
// it matters, in rising order:
//   fresh      main hasn't moved
//   behind     it moved, but nothing the job touches
//   touched    what landed changed the job's files or tests, or a contract
//   conflicts  the job's work, as it stands, won't merge onto main
//   breaks     it merges, but the job's checks fail on today's main
// "breaks" needs the checks run (--run), once per main and per state of the
// work; the answer is remembered.

export function syncMain(root, plan) {
  const main = plan.main ?? 'main';
  if (!hasOrigin(root)) return false;
  return bumpIfRefsMove(root, () => git(['fetch', '-q', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`], { cwd: root, allow: true }).ok);
}

const movedFile = root => join(stateDir(root), 'moved.json');
const toldFile = root => join(stateDir(root), 'told.json');
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);

// `main` and `done` may be passed in by a caller that already knows them
// (board, for every worktree of one repository).
export function movedFor(root, plan, { run = false, main: knownMain, done: knownDone } = {}) {
  const c = current(root);
  const j = c && plan.jobs.find(x => x.id === c.job);
  if (!j) return null;
  const main = knownMain ?? mainRef(root, plan);
  if (main === 'HEAD') return { job: j.id, level: 'fresh', behind: 0, landed: [], touched: [], conflicts: [], failing: [], checked: false };
  // A job that has landed is done: its leftover claim isn't checked.
  if ((knownDone ?? doneJobs(root, main)).has(j.id)) return null;
  const tip = git(['rev-parse', main], { cwd: root });
  const base = git(['merge-base', 'HEAD', main], { cwd: root, allow: true }).out;
  const out = { job: j.id, level: 'fresh', behind: 0, landed: [], changed: [], touched: [], conflicts: [], failing: [], checked: false, tip };
  if (!base || base === tip) return out;
  out.behind = Number(git(['rev-list', '--count', `${base}..${tip}`], { cwd: root }));
  // Jobs are named from the plan on main: it may know jobs this work's own
  // copy of the plan doesn't.
  const ids = new Set([...plan.jobs, ...(planAt(root, tip)?.jobs ?? [])].map(o => o.id));
  out.landed = [...new Set(git(['log', '--format=%s', `${base}..${tip}`], { cwd: root }).split('\n').map(x => x.match(/^([a-z0-9][a-z0-9._-]*):/)?.[1]).filter(id => id && ids.has(id)))];
  // The plan's own files aren't the code a job builds on.
  const files = git(['diff', '--name-only', base, tip], { cwd: root }).split('\n').filter(f => f && !f.startsWith('.gmod/'));
  out.changed = files;
  out.touched = files.filter(f => allowed(j, f) || matches(plan.contracts, f));
  // The work as it stands, committed or not, as a commit on HEAD; merged
  // onto main without touching the worktree.
  const tree = fingerprint(root);
  const ident = { GIT_AUTHOR_NAME: 'gmod', GIT_AUTHOR_EMAIL: 'gmod@local', GIT_COMMITTER_NAME: 'gmod', GIT_COMMITTER_EMAIL: 'gmod@local' };
  const work = git(['commit-tree', tree, '-p', 'HEAD', '-m', 'gmod: the work in progress'], { cwd: root, env: ident });
  const merged = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', work, tip], { cwd: root, allow: true });
  const [mergedTree, ...conflicted] = merged.out.split('\n').filter(Boolean);
  if (!merged.ok) {
    out.conflicts = [...new Set(conflicted)];
    out.level = 'conflicts';
    return out;
  }
  out.level = out.touched.length ? 'touched' : 'behind';
  // Checks run on any landing, not only on the job's declared files: what a
  // job really depends on (an import, a fixture) is rarely all declared.
  const key = `${tree}:${tip}`;
  const known = readJson(movedFile(root), {});
  if (known.key === key) {
    out.checked = true;
    out.failing = known.failing;
  } else if (run) {
    out.checked = true;
    out.failing = checksOn(root, plan, j, git(['commit-tree', mergedTree, '-p', tip, '-m', 'gmod: the work on main'], { cwd: root, env: ident }));
    writeFileSync(movedFile(root), JSON.stringify({ key, failing: out.failing }));
    bump(root);
  }
  if (out.failing.length) out.level = 'breaks';
  return out;
}

function checksOn(root, plan, j, commit) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-moved-'));
  const wt = join(dir, 'wt');
  try {
    git(['worktree', 'add', '-q', '--detach', wt, commit], { cwd: root });
    return runChecks(wt, plan, j).filter(r => !r.pass).map(r => r.criterion);
  } finally {
    teardown(wt, plan);
    git(['worktree', 'remove', '--force', wt], { cwd: root, allow: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every worktree's job, as it stands against main.
export function moved(root, plan, { run = false, fetch = true } = {}) {
  if (fetch) syncMain(root, plan);
  return worktrees(root).map(wt => movedFor(wt.path, plan, { run })).filter(Boolean);
}

// What the agent working at `path` should hear, once per state of main:
// nothing for fresh or behind.
export function notice(path, { cwd = process.cwd() } = {}) {
  let dir = resolve(cwd, path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  if (!statSync(dir).isDirectory()) dir = dirname(dir);
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir, allow: true });
  if (!top.ok) return '';
  // The person's answers to what this worktree asked, once each.
  const answers = untold(top.out).map(r => r.resolved
    ? `gmod: the person closed your question about ${r.job}, "${r.question}", without an answer${r.note ? `: ${r.note}` : ''}.`
    : `gmod: the person answered your question about ${r.job}, "${r.question}": ${r.answer}`);
  const moved = movedNotice(top.out);
  return [...answers, ...(moved ? [moved] : [])].join('\n');
}

function movedNotice(root) {
  const top = { out: root };
  const plan = planFromDisk(top.out);
  const m = plan && movedFor(top.out, plan);
  if (!m || ['fresh', 'behind'].includes(m.level)) return '';
  const key = `${m.level}:${m.tip}:${m.failing.join('|')}`;
  if (readJson(toldFile(top.out), {}).key === key) return '';
  writeFileSync(toldFile(top.out), JSON.stringify({ key }));
  const what = m.landed.length ? `${m.landed.join(', ')} landed on main` : `main moved ${m.behind} ${m.behind === 1 ? 'commit' : 'commits'}`;
  if (m.level === 'conflicts') {
    return `gmod: ${what}, and your work on ${m.job} conflicts with main in ${m.conflicts.join(', ')}. Rebase onto origin/main and resolve it before going on.`;
  }
  const files = m.touched.length ? m.touched : m.changed;
  const changed = `${what} and changed ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
  if (m.level === 'breaks') {
    return `gmod: ${changed}. On today's main, ${m.failing.map(f => `"${f}"`).join(' and ')} ${m.failing.length === 1 ? 'fails' : 'fail'} for ${m.job}. Rebase onto origin/main, fix it, then run mcp__gmod__check. If a criterion itself no longer fits what landed, don't bend the test: draft the change with mcp__gmod__edit_job and tell the person.`;
  }
  return `gmod: ${changed}, which ${m.job} builds on. Rebase onto origin/main and run mcp__gmod__check before you commit.`;
}

// ---------- claim / release ----------

export function claim(root, id, { branch = true, resume = false } = {}) {
  const plan = planFromDisk(root);
  if (!plan) throw new GmodError(`no ${PLAN} here`);
  job(plan, id);
  const mine = current(root);
  if (mine && mine.job !== id) throw new GmodError(`this worktree already works ${mine.job}: release it first`);
  const s = states(root, plan).find(x => x.id === id);
  if (s.state === 'done') throw new GmodError(`${id} is already done on main`);
  if (s.state === 'waiting') throw new GmodError(`${id} waits for ${s.waiting.join(', ')}`);
  if (s.state === 'claimed') {
    if (mine?.job === id) return { job: id, by: s.by, again: true };
    // Your own claim, held from another run or machine (an agent in CI
    // picking its job back up to fix its pull request): carry on with it.
    if (branch && s.by === who(root)) return adopt(root, plan, id);
    throw new GmodError(`${id} is claimed by ${s.by}`);
  }
  // Finished work already on origin's gmod/<job> (a pull request that was
  // closed, or never opened): starting again beside it can't be pushed, and
  // carrying on from it can't fail first. Only resuming it to open its pull
  // request makes sense; anything else is a person's call.
  const remoteBranch = `refs/remotes/origin/gmod/${id}`;
  if (branch && !resume && git(['rev-parse', '-q', '--verify', remoteBranch], { cwd: root, allow: true }).ok
    && !git(['rev-parse', '-q', '--verify', `refs/heads/gmod/${id}`], { cwd: root, allow: true }).ok) {
    const subjects = git(['log', '--format=%s', `${mainRef(root, plan)}..${remoteBranch}`], { cwd: root, allow: true }).out;
    if (subjects.split('\n').some(x => x.startsWith(`${id}:`))) throw new GmodError(`gmod/${id} on origin already holds finished work for ${id}: open its pull request (gmod pr --auto), or delete the branch to start over`);
  }
  // Its branch still checked out in another worktree (a run that released
  // the job and stopped): this worktree couldn't switch to it, and the work
  // would go up from the wrong branch. Say where it is and how to free it.
  if (branch) {
    const here = realpathSync(root);
    const there = worktrees(root).find(w => w.branch === `gmod/${id}` && realpathSync(w.path) !== here);
    if (there) throw new GmodError(`gmod/${id} is checked out in ${there.path}: free it there (git -C ${there.path} switch --detach), or remove that worktree (git worktree remove ${there.path}), then claim again`);
  }
  const by = who(root);
  const info = { job: id, by, at: new Date().toISOString() };
  const ident = { GIT_AUTHOR_NAME: 'gmod', GIT_AUTHOR_EMAIL: 'gmod@local', GIT_COMMITTER_NAME: 'gmod', GIT_COMMITTER_EMAIL: 'gmod@local' };
  const obj = git(['commit-tree', EMPTY_TREE, '-m', JSON.stringify(info)], { cwd: root, env: ident });
  const ref = CLAIMS + id;
  if (!git(['update-ref', ref, obj, ''], { cwd: root, allow: true }).ok) throw new GmodError(`${id} was claimed a moment ago`);
  if (hasOrigin(root)) {
    // The push is the lock: a ref that already exists on origin refuses it.
    const pushed = git(['push', '-q', 'origin', `${ref}:${ref}`], { cwd: root, allow: true });
    if (!pushed.ok) {
      git(['update-ref', '-d', ref], { cwd: root, allow: true });
      syncClaims(root);
      throw new GmodError(`${id} was claimed first by ${claims(root)[id]?.by ?? 'someone else'}`);
    }
  }
  writeFileSync(claimFile(root), JSON.stringify({ ...info, obj }, null, 2));
  bump(root);
  return { ...info, note: branch ? toBranch(root, id) : '' };
}

// Onto the job's branch: the local one, origin's (work someone started, or
// finished but never opened: carry on from it rather than start beside it),
// or a new one.
function toBranch(root, id) {
  const name = `gmod/${id}`;
  const dirty = git(['status', '--porcelain'], { cwd: root }).length > 0;
  const exists = git(['rev-parse', '-q', '--verify', `refs/heads/${name}`], { cwd: root, allow: true }).ok;
  const remote = !exists && git(['rev-parse', '-q', '--verify', `refs/remotes/origin/${name}`], { cwd: root, allow: true }).ok;
  const r = git(exists ? ['switch', '-q', name] : remote ? ['switch', '-q', '-c', name, '--track', `origin/${name}`] : ['switch', '-q', '-c', name], { cwd: root, allow: true });
  return r.ok ? `on branch ${name}` : `stay on your branch (${dirty ? 'uncommitted changes' : r.err}); name the pull request "${id}: …"`;
}

// Which other worktree of this repository holds the claim on a job, if any.
function heldElsewhere(root, id) {
  const here = realpathSync(root);
  for (const w of worktrees(root)) {
    if (realpathSync(w.path) === here) continue;
    const dir = git(['rev-parse', '--git-dir'], { cwd: w.path, allow: true });
    if (!dir.ok) continue;
    const f = join(resolve(w.path, dir.out), 'gmod', 'claim.json');
    try { if (JSON.parse(readFileSync(f, 'utf8')).job === id) return w.path; } catch { /* none there */ }
  }
  return null;
}

// Pick up your own claimed job where its branch on origin left it. Its
// failing run is the proof's: the job's tests, with its code put back, fail.
function adopt(root, plan, id) {
  const name = `gmod/${id}`;
  git(['fetch', '-q', 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`], { cwd: root, allow: true });
  if (!git(['rev-parse', '-q', '--verify', `refs/remotes/origin/${name}`], { cwd: root, allow: true }).ok) {
    // Nothing pushed yet. Held in another worktree here: that's where it's
    // worked. Held nowhere (its worktree was removed, or another machine's run
    // ended before pushing): there's no work to pick up, so take the claim over
    // and start here, red first like any new claim.
    const there = heldElsewhere(root, id);
    if (there) throw new GmodError(`${id} is claimed by you in ${there}: carry on there, or release it there first`);
    const held = claims(root)[id];
    const info = { job: id, by: who(root), at: new Date().toISOString() };
    writeFileSync(claimFile(root), JSON.stringify({ ...info, obj: held?.obj, adopted: true }, null, 2));
  bump(root);
    return { ...info, adopted: true, note: `${toBranch(root, id)}; took over your own claim, which no worktree held and nothing had been pushed for` };
  }
  if (git(['status', '--porcelain'], { cwd: root }).length) throw new GmodError(`uncommitted changes here: ${id} is picked up on a clean worktree`);
  git(['switch', '-q', '-C', name, '--track', `origin/${name}`], { cwd: root });
  const held = claims(root)[id];
  const info = { job: id, by: who(root), at: new Date().toISOString() };
  writeFileSync(claimFile(root), JSON.stringify({ ...info, obj: held?.obj, adopted: true }, null, 2));
  bump(root);
  const j = job(plan, id);
  const base = git(['merge-base', mainRef(root, plan), 'HEAD'], { cwd: root });
  const p = prove(root, id, base, 'HEAD', plan);
  if (p.without?.some(r => !r.pass)) {
    const record = { result: 'red', fingerprint: 'proof', checks: checksKey(plan, j), at: new Date().toISOString(), results: p.without, proof: true };
    writeFileSync(evidenceFile(root, id), JSON.stringify([...evidence(root, id), record].slice(-50), null, 2));
    journalAppend(root, plan, j, 'pick up', 'red from the proof: with the code put back, the criteria fail');
    return { ...info, adopted: true, note: `on branch ${name}, where it was left; red recorded from the proof (the tests fail with the code put back)` };
  }
  return { ...info, adopted: true, note: `on branch ${name}, where it was left; no red yet: the tests don't fail with the code put back, so make them, then gmod check` };
}

export function release(root, id) {
  const mine = current(root);
  id ??= mine?.job;
  if (!id) throw new GmodError('nothing claimed here');
  const ref = CLAIMS + id;
  const obj = git(['rev-parse', '-q', '--verify', ref], { cwd: root, allow: true });
  if (obj.ok && hasOrigin(root)) {
    git(['push', '-q', `--force-with-lease=${ref}:${obj.out}`, 'origin', `:${ref}`], { cwd: root, allow: true });
  }
  git(['update-ref', '-d', ref], { cwd: root, allow: true });
  if (mine?.job === id) rmSync(claimFile(root), { force: true });
  const note = mine?.job === id ? offBranch(root, id) : '';
  bump(root);
  return { job: id, ...(note ? { note } : {}) };
}

// Released here: step this worktree off gmod/<job>, so the next claim, in any
// worktree, can switch to it, and delete the branch when it holds nothing
// beyond main. Work on it, committed or not, is left exactly where it is.
function offBranch(root, id) {
  const name = `gmod/${id}`;
  if (git(['branch', '--show-current'], { cwd: root, allow: true }).out !== name) return '';
  if (git(['status', '--porcelain'], { cwd: root }).length) return `left on ${name}: it has uncommitted changes`;
  const plan = planFromDisk(root) ?? {};
  const main = mainRef(root, plan);
  const ahead = Number(git(['rev-list', '--count', `${main}..${name}`], { cwd: root, allow: true }).out || 0);
  if (ahead > 0) return `left on ${name}: it has ${ahead} commit${ahead === 1 ? '' : 's'} beyond main`;
  const local = plan.main ?? 'main';
  if (!git(['switch', '-q', local], { cwd: root, allow: true }).ok) git(['switch', '-q', '--detach', main], { cwd: root, allow: true });
  if (git(['branch', '--show-current'], { cwd: root, allow: true }).out === name) return `left on ${name}: couldn't switch off it`;
  git(['branch', '-q', '-D', name], { cwd: root, allow: true });
  return `off ${name}, which held no work and is deleted`;
}

// ---------- checks and evidence ----------

// The worktree as a tree id, untracked files included: what a commit of
// "everything" would hold. Equal ids mean nothing changed in between.
export function fingerprint(root) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-idx-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    git(['read-tree', 'HEAD'], { cwd: root, env, allow: true });
    // ...nor does committing that note: the journal counts on neither side.
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.gmod/evidence', '.gmod/journal'], { cwd: root, env, allow: true });
    // The journal is written about the work, not part of it: a note after a
    // passing check doesn't make the files differ.
    git(['add', '-A', '--', '.', ':(exclude).gmod/evidence', ':(exclude).gmod/journal'], { cwd: root, env });
    // A repository nested in the worktree (an agent's worktree) is never
    // committed, so its moving on doesn't make these files differ either.
    const tracked = new Set(git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd: root, allow: true }).out.split('\0'));
    const nested = git(['ls-files', '-s', '-z'], { cwd: root, env }).split('\0')
      .filter(e => e.startsWith('160000 ')).map(e => e.slice(e.indexOf('\t') + 1)).filter(p => !tracked.has(p));
    if (nested.length) git(['update-index', '--force-remove', '--', ...nested], { cwd: root, env });
    return git(['write-tree'], { cwd: root, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runChecks(dir, plan, j) {
  const results = [];
  for (const c of j.done_when) {
    const cmd = plan.checks[c.check];
    const r = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: CHECK_TIMEOUT, maxBuffer: 64 << 20 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // Killed at the timeout, a check never reached its own cleanup.
    if (r.signal) teardown(dir, plan);
    results.push({ criterion: c.text, check: c.check, pass: r.status === 0, tail: out.split('\n').slice(-15).join('\n').trim() });
  }
  return results;
}

const CHECK_TIMEOUT = 10 * 60_000;

// The plan's teardown, run where the checks ran; what it says is not
// gmod's business, and a failing teardown doesn't fail the checks.
function teardown(dir, plan) {
  if (typeof plan?.teardown !== 'string' || !plan.teardown.trim() || !existsSync(dir)) return;
  spawnSync('sh', ['-c', plan.teardown], { cwd: dir, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 16 << 20 });
}

export function check(root, id) {
  const plan = planFromDisk(root);
  id ??= current(root)?.job;
  if (!id) throw new GmodError('claim a job first, or name one');
  const j = job(plan, id);
  const results = runChecks(root, plan, j);
  const green = results.every(r => r.pass);
  const record = { result: green ? 'green' : 'red', fingerprint: fingerprint(root), checks: checksKey(plan, j), at: new Date().toISOString(), results };
  const all = [...evidence(root, id), record].slice(-50);
  writeFileSync(evidenceFile(root, id), JSON.stringify(all, null, 2));
  const failed = results.filter(r => !r.pass).map(r => r.criterion);
  journalAppend(root, plan, j, 'check', green ? 'green' : `red (${failed.join('; ')})`);
  publishVerdict(root, { job: id, pass: green, failing: failed, checks: record.checks, by: who(root), at: record.at, head: git(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, allow: true }).out });
  return { job: id, ...record, sawRed: all.some(r => r.result === 'red' && r.checks === record.checks) };
}

// ---------- shared verdicts: is a job red, wherever it is worked ----------
//
// A job's latest verdict, at refs/gmod/runs/<job> (ADR 0002): a signal for
// everyone else, never proof. The gate proves every pull request again and
// never reads these. Publishing is best effort: a check never fails for it.

const RUNS = 'refs/gmod/runs/';
const RUN_FILE = 'run.json';

function publishVerdict(root, verdict) {
  try {
    if (shared.writeJson(root, RUNS + verdict.job, RUN_FILE, verdict, { history: false })) shared.publishOver(root, RUNS + verdict.job);
  } catch {
    // Kept locally at most; the check itself stands.
  }
}

// The verdict of a job worked elsewhere, if it speaks for that claim under
// today's checks.
function verdictFor(root, plan, j, claim) {
  const v = shared.readJson(root, RUNS + j.id, RUN_FILE);
  if (!v || v.checks !== checksKey(plan, j)) return null;
  if (claim?.at && String(v.at) < String(claim.at)) return null;
  return v;
}

// ---------- the journal: what a job meant to do, tried and found ----------
//
// .gmod/journal/<job>.md travels with the job's pull request: the reviewer
// reads it, and it stays on main with the work.

export const journalPath = id => `.gmod/journal/${id}.md`;

function journalAppend(root, plan, j, who_, text) {
  const file = join(root, journalPath(j.id));
  mkdirSync(dirname(file), { recursive: true });
  const head = existsSync(file) ? '' : `# ${j.id}: ${j.goal}\n\n`;
  const line = `- ${new Date().toISOString()} ${who_}: ${String(text).replace(/\s*\n\s*/g, ' ').trim()}\n`;
  writeFileSync(file, (existsSync(file) ? readFileSync(file, 'utf8') : '') + head + line);
  bump(root);
}

export function note(root, text, id) {
  const plan = planFromDisk(root);
  id ??= current(root)?.job;
  if (!id) throw new GmodError('claim a job first, or name one: gmod note <text> --job <job>');
  if (!String(text ?? '').trim()) throw new GmodError('what should the note say?');
  journalAppend(root, plan, job(plan, id), who(root), text);
  return { job: id, file: journalPath(id) };
}

export function journal(root, id) {
  const file = join(root, journalPath(id));
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map(l => l.match(/^- (\S+) ([^:]+): (.*)$/)).filter(Boolean).map(([, at, by, text]) => ({ at, by, text }));
}

// What a commit needs: a claim, a red seen first, and a green on exactly
// what is about to be committed.
export function gateCommit(root) {
  const mine = current(root);
  if (!planFromDisk(root)) return { ok: true, reason: 'no plan here: not governed' };
  if (!mine) {
    // A CI change travels alone, with no job claimed: CI judges it.
    const staged = git(['diff', '--cached', '--name-only'], { cwd: root }).split('\n').filter(Boolean);
    if (staged.length && staged.every(f => isCiFile(f))) return { ok: true, reason: 'a CI change on its own: its pull request is checked and reviewed in CI' };
    return { ok: false, reason: 'claim a job first (gmod claim <job>)' };
  }
  const plan = planFromDisk(root);
  const ev = proof(root, plan, mine.job, mine.at);
  if (!ev.some(r => r.result === 'red')) {
    const stale = evidence(root, mine.job).some(r => r.at >= mine.at && r.result === 'red');
    return {
      ok: false,
      reason: stale
        ? `${mine.job}: its checks changed since the failing run, so that run proves nothing now: set the code aside (git stash), gmod check to see it fail, bring it back, gmod check again`
        : `${mine.job}: no failing run recorded before it passed: run gmod check while the criteria still fail`,
    };
  }
  const m = movedFor(root, plan);
  if (m?.level === 'breaks') {
    return { ok: false, reason: `${mine.job}: ${m.failing.map(f => `"${f}"`).join(' and ')} ${m.failing.length === 1 ? 'fails' : 'fail'} on today's main (${m.landed.join(', ') || 'main'} changed ${(m.touched.length ? m.touched : m.changed).slice(0, 3).join(', ')}): rebase onto origin/main, fix it, then gmod check` };
  }
  const last = ev.at(-1);
  if (last.result !== 'green') return { ok: false, reason: `${mine.job}: the last check failed: make it pass, then gmod check` };
  if (last.fingerprint !== fingerprint(root)) return { ok: false, reason: `${mine.job}: files changed since the last passing check: run gmod check again` };
  return { ok: true, reason: `${mine.job}: failed first, passes on exactly these files` };
}

// Commit the claimed job's work: everything the last passing check ran on,
// under "<job>: …". No raw git commit, so nothing for a shell guard to
// mistake, and the worktree judged is the one committed.
// Before a job's branch is pushed: CI may have brought origin's copy up to
// date with main while the work went on (a merge of main, nothing else). Take
// those merges in so the push goes through. Anything else on origin's branch
// is someone's work: refuse, and let a person look.
export function catchUp(root, branch, main = 'main') {
  if (!hasOrigin(root)) return { merged: false };
  git(['fetch', '-q', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: root, allow: true });
  const remote = `refs/remotes/origin/${branch}`;
  if (!git(['rev-parse', '-q', '--verify', remote], { cwd: root, allow: true }).ok) return { merged: false };
  if (git(['merge-base', '--is-ancestor', remote, 'HEAD'], { cwd: root, allow: true }).ok) return { merged: false };
  const theirs = git(['rev-list', '--parents', `HEAD..${remote}`, '--not', `refs/remotes/origin/${main}`], { cwd: root }).split('\n').filter(Boolean).map(l => l.split(' '));
  const fromMain = theirs.every(([, first, ...others]) => others.length > 0
    && others.every(p => git(['merge-base', '--is-ancestor', p, `refs/remotes/origin/${main}`], { cwd: root, allow: true }).ok));
  if (!fromMain) throw new GmodError(`origin's ${branch} has commits that aren't merges of ${main}: look at them (git log HEAD..origin/${branch}) before pushing`);
  const ident = { GIT_AUTHOR_NAME: 'gmod', GIT_AUTHOR_EMAIL: 'gmod@local', GIT_COMMITTER_NAME: 'gmod', GIT_COMMITTER_EMAIL: 'gmod@local' };
  const m = git(['merge', '-q', '--no-edit', remote], { cwd: root, env: ident, allow: true });
  if (!m.ok) {
    git(['merge', '--abort'], { cwd: root, allow: true });
    throw new GmodError(`taking in ${main}'s merges from origin's ${branch} conflicts: ${m.err.trim().split('\n')[0]}`);
  }
  return { merged: true, count: theirs.length };
}

export function commitJob(root, { message, trailers = [] } = {}) {
  const plan = planFromDisk(root);
  const mine = current(root);
  const g = gateCommit(root);
  if (!g.ok) throw new GmodError(g.reason);
  const j = job(plan, mine.job);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  if (branch === plan.main || branch === 'HEAD') throw new GmodError(`on ${branch}: a job commits on its own branch (gmod/${j.id})`);
  // Only the job's own paths, spelled literally (a file name is no glob), and
  // committed alone: whatever else sits in the index stays there, uncommitted.
  const paths = jobPaths(root, j);
  const lit = { GIT_LITERAL_PATHSPECS: '1' };
  if (paths.length) git(['add', '-A', '--', ...paths], { cwd: root, env: lit });
  if (!paths.length || git(['diff', '--cached', '--quiet', 'HEAD', '--', ...paths], { cwd: root, env: lit, allow: true }).ok) {
    // Committed already, green on exactly this tree, but not on origin yet (a
    // push that was refused): push what's there rather than refuse.
    const head = git(['log', '-1', '--format=%s'], { cwd: root });
    const pushed = git(['branch', '-r', '--contains', 'HEAD'], { cwd: root, allow: true }).out.split('\n').some(b => b.trim() === `origin/${branch}`);
    if (head.startsWith(`${j.id}:`) && !pushed) return { job: j.id, branch, subject: head, commit: git(['rev-parse', 'HEAD'], { cwd: root }), existing: true };
    throw new GmodError(`${j.id}: nothing to commit`);
  }
  const text = String(message ?? '').trim() || j.goal;
  const subject = text.startsWith(`${j.id}:`) ? text : `${j.id}: ${text}`;
  const body = [subject, ...(trailers.length ? ['', ...trailers] : [])].join('\n');
  git(['commit', '-q', '-F', '-', '--only', '--', ...paths], { cwd: root, env: lit, input: body + '\n' });
  return { job: j.id, branch, subject: subject.split('\n')[0], commit: git(['rev-parse', 'HEAD'], { cwd: root }) };
}

// What a job's commit holds: the paths changed (added, modified, deleted, or
// either side of a rename) within its files and tests, and its journal.
// Never a path outside the job, and never another repository nested in the
// worktree (an agent's worktree, a clone): git would commit it as a gitlink.
function jobPaths(root, j) {
  const z = args => git(args, { cwd: root }).split('\0').filter(Boolean);
  const tracked = z(['diff', '--name-only', '-z', '--no-renames', 'HEAD']);
  // A nested repository is listed as its directory, with a trailing slash.
  const untracked = z(['ls-files', '-z', '--others', '--exclude-standard']).filter(p => !p.endsWith('/'));
  const isDir = p => { try { return lstatSync(join(root, p)).isDirectory(); } catch { return false; } };
  return [...new Set([...tracked, ...untracked])]
    .filter(p => (allowed(j, p) || p === journalPath(j.id)) && !isDir(p))
    .sort();
}

// May this file be written? The repository is the one the file is in, so a
// subagent in a worktree of its own answers to its own claim. gmod's records
// in the git directory are written only by gmod.
export function guardFile(path, { cwd = process.cwd(), allowPlan = false } = {}) {
  // Spelled as git spells it (symbolic links resolved: /var is /private/var
  // on macOS), or a path in the repository would look like one outside it.
  let dir = dirname(resolve(cwd, path));
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const abs = join(realpathSync(dir), relative(dir, resolve(cwd, path)));
  const r = git(['rev-parse', '--is-inside-git-dir', '--show-toplevel'], { cwd: dir, allow: true });
  if (!r.ok) {
    // Not in a work tree. Inside a git directory? (rev-parse can't answer
    // --show-toplevel there, so ask again without it.)
    const g = git(['rev-parse', '--is-inside-git-dir'], { cwd: dir, allow: true });
    if (g.ok && g.out === 'true' && /(^|\/)gmod(\/|$)/.test(abs)) return { ok: false, reason: "gmod's own records change only through gmod" };
    return { ok: true };
  }
  const [insideGitDir, top] = r.out.split('\n');
  if (insideGitDir === 'true') return /(^|\/)gmod(\/|$)/.test(abs) ? { ok: false, reason: "gmod's own records change only through gmod" } : { ok: true };
  return guardPath(top, abs, { allowPlan });
}

// May this file of this repository be written? Only within the claimed job's
// files and tests; the plan itself only when a person allowed it.
export function guardPath(root, path, { allowPlan = false } = {}) {
  const rel = relative(root, resolve(root, path)).split(sep).join('/');
  if (rel.startsWith('..') || rel === '' || rel.startsWith('.git/')) return { ok: true };
  if (rel === PLAN) return allowPlan ? { ok: true } : { ok: false, reason: `${PLAN} changes only after a person runs /gmod allow-plan` };
  if (rel.startsWith('.gmod/')) return { ok: true };
  const plan = planFromDisk(root);
  if (!plan) return { ok: true };
  if (rel.startsWith(`${adrDir(plan)}/`)) return { ok: false, reason: `${rel}: decision records change only through a draft a person accepts (mcp__gmod__adr_propose)` };
  const mine = current(root);
  // CI's own files are a change of their own, not a job's: with no job
  // claimed here, CI's gate and review judge it on its pull request.
  if (!mine && isCiFile(rel)) return { ok: true };
  if (!mine) return { ok: false, reason: `claim a job before changing ${rel} (gmod next, then gmod claim <job>)` };
  const j = plan.jobs.find(x => x.id === mine.job);
  if (!j) return { ok: false, reason: `the claimed job ${mine.job} is no longer in the plan` };
  return allowed(j, rel) ? { ok: true } : { ok: false, reason: `${rel} is outside ${j.id}'s files (${[...j.files, ...(j.tests ?? [])].join(', ')})` };
}

// ---------- prove: the tests depend on the change ----------

export function prove(root, id, base, head = 'HEAD', plan) {
  plan ??= planAt(root, base) ?? planFromDisk(root);
  const j = job(plan, id);
  const changed = git(['diff', '--name-only', `${base}...${head}`], { cwd: root }).split('\n').filter(Boolean);
  const code = changed.filter(f => matches(j.files, f) && !matches(j.tests, f));
  const steps = [];
  if (!code.length) return { ok: false, steps: [`no code of ${id} changed outside its tests, so nothing shows the tests depend on it`] };
  const dir = mkdtempSync(join(tmpdir(), 'gmod-prove-'));
  const wt = join(dir, 'wt');
  try {
    git(['worktree', 'add', '-q', '--detach', wt, head], { cwd: root });
    const atHead = runChecks(wt, plan, j);
    const headOk = atHead.every(r => r.pass);
    // Say why: CI is a fresh checkout, so what passed at the desk may not.
    const why = atHead.filter(r => !r.pass).map(r => `\n  - "${r.criterion}" fails:\n\n    \`\`\`\n${r.tail.split('\n').slice(-8).map(l => `    ${l}`).join('\n')}\n    \`\`\``).join('');
    steps.push(`${headOk ? 'pass' : 'FAIL'}: the criteria pass with the change (${atHead.filter(r => r.pass).length}/${atHead.length})${why}`);
    for (const f of code) {
      const there = git(['cat-file', '-e', `${base}:${f}`], { cwd: wt, allow: true }).ok;
      if (there) git(['checkout', '-q', base, '--', f], { cwd: wt });
      else rmSync(join(wt, f), { force: true });
    }
    const without = runChecks(wt, plan, j);
    const failsWithout = without.some(r => !r.pass);
    steps.push(`${failsWithout ? 'pass' : 'FAIL'}: with the code put back and the new tests kept, the criteria fail (${without.filter(r => !r.pass).map(r => r.criterion).join('; ') || 'none failed'})`);
    return { ok: headOk && failsWithout, steps, atHead, without };
  } finally {
    teardown(wt, plan);
    git(['worktree', 'remove', '--force', wt], { cwd: root, allow: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- verify: the CI gate ----------

// The files that make up CI itself: workflows and who owns what.
// main's protection as the repository declares it: which checks a merge
// needs. The forge holds the live setting; the gate holds it to this.
export const PROTECT = '.gmod/protect.json';
const CI_FILES = ['.github/workflows/**', '.gitea/workflows/**', '.gitlab-ci.yml', '.github/CODEOWNERS', '.gitea/CODEOWNERS', '.gitlab/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', PROTECT];

// { require: ['gate', 'review'], up_to_date: true }, from a commit or the disk.
export function protectSpec(root, ref) {
  const text = ref ? git(['show', `${ref}:${PROTECT}`], { cwd: root, allow: true }) : { ok: existsSync(join(root, PROTECT)), out: existsSync(join(root, PROTECT)) ? readFileSync(join(root, PROTECT), 'utf8') : '' };
  if (!text.ok) return null;
  let spec;
  try {
    spec = JSON.parse(text.out);
  } catch {
    throw new GmodError(`${PROTECT} isn't JSON`);
  }
  const require = spec.require ?? ['gate'];
  if (!Array.isArray(require) || require.some(r => !['gate', 'review'].includes(r)) || !require.includes('gate')) {
    throw new GmodError(`${PROTECT}: "require" lists "gate" and, if wanted, "review"`);
  }
  return { require, up_to_date: spec.up_to_date !== false };
}
export const isCiFile = f => matches(CI_FILES, f);

// A job of CI's own: every one of its files is a CI file, and its tests, if
// any, are governance checks under .gmod/checks/. Its pull request is a CI
// change, made and proven as a job.
const GOVERNANCE_CHECKS = '.gmod/checks/';
const plainPath = g => !g.split('/').includes('..');
export const isCiJob = j => (j.files ?? []).length > 0
  && j.files.every(g => plainPath(g) && isCiFile(g))
  && (j.tests ?? []).every(g => plainPath(g) && g.startsWith(GOVERNANCE_CHECKS));

// The job a pull request works: its branch gmod/<job>, a title "<job>: …",
// or its commits' subjects.
export function jobNamed(root, { mb, head, branch = '', title = '' }) {
  const subjects = git(['log', '--format=%s', `${mb}..${head}`], { cwd: root }).split('\n');
  return branch.match(/^gmod\/(.+)$/)?.[1] ?? title.match(/^([a-z0-9][a-z0-9._-]*):/)?.[1]
    ?? subjects.map(s => s.match(/^([a-z0-9][a-z0-9._-]*):/)?.[1]).find(Boolean) ?? null;
}

export function verify(root, { base, head = 'HEAD', branch = '', title = '' }) {
  const findings = [];
  const fail = msg => findings.push({ ok: false, msg });
  const pass = msg => findings.push({ ok: true, msg });
  const mb = git(['merge-base', base, head], { cwd: root });
  const plan = planAt(root, mb);
  if (!plan) return { ok: true, mode: 'ungoverned', findings: [{ ok: true, msg: `no ${PLAN} on the base: nothing to govern` }] };
  const changed = git(['diff', '--name-only', `${mb}...${head}`], { cwd: root }).split('\n').filter(Boolean);
  const adr = plan.adr_dir ? plan.adr_dir.replace(/\/?$/, '/') : null;
  // Nothing changed: the base already holds it (a base that moved past the
  // pull request), or the branch is empty. Either way there's nothing to pass.
  if (!changed.length) {
    fail(`nothing changed between ${base.slice(0, 12)} and ${head}: check against the pull request's own base`);
    return { ok: false, mode: 'empty', findings };
  }

  // The managed switch is a person's decision, like the plan, and it travels
  // alone: not even with the plan (ADR 0001).
  if (changed.includes(MANAGED_SWITCH)) {
    const other = changed.filter(f => f !== MANAGED_SWITCH);
    other.length ? fail(`the managed switch travels alone; also changed: ${other.join(', ')}`) : pass('the managed switch on its own');
    const text = git(['show', `${head}:${MANAGED_SWITCH}`], { cwd: root, allow: true });
    if (!text.ok) pass('the managed switch is removed: managed mode is off');
    else {
      let s = null;
      try { s = JSON.parse(text.out); } catch { /* reported below */ }
      s && s.v === 1 && typeof s.managed === 'boolean'
        ? pass(`the switch turns managed mode ${s.managed ? 'on' : 'off'}`)
        : fail(`${MANAGED_SWITCH} isn't a valid switch: { "v": 1, "managed": true | false }`);
    }
    pass('the review checks it weakens nothing that is checked');
    return { ok: findings.every(f => f.ok), mode: 'managed', findings };
  }

  if (changed.includes(PLAN)) {
    // ADRs may live in the base's folder or, when this change moves them, the new plan's.
    let headPlan = null;
    try { headPlan = planAt(root, head); } catch { /* reported below */ }
    const adrDirs = [...new Set([adr, `${adrDir(plan)}/`, headPlan && `${adrDir(headPlan)}/`].filter(Boolean))];
    const other = changed.filter(f => !f.startsWith('.gmod/') && !adrDirs.some(d => f.startsWith(d)));
    other.length ? fail(`a plan change carries only the plan (and ADRs); also changed: ${other.join(', ')}`) : pass('a plan change on its own');
    try {
      planAt(root, head);
      pass('the new plan is valid');
    } catch (e) {
      fail(e.message);
    }
    pass('the review checks it weakens nothing that is checked');
    return { ok: findings.every(f => f.ok), mode: 'plan', findings };
  }

  // A decision record changes on its own, for the owners to review.
  const adrPrefix = `${adrDir(plan)}/`;
  if (changed.some(f => f.startsWith(adrPrefix))) {
    const other = changed.filter(f => !f.startsWith(adrPrefix));
    other.length ? fail(`a decision record travels alone; also changed: ${other.join(', ')}`) : pass('a decision record on its own');
    pass('the review checks it weakens nothing that is checked');
    return { ok: findings.every(f => f.ok), mode: 'adr', findings };
  }

  // CI's own files change on their own, like the plan, and the owners review
  // them: a pull request runs its own copy of the workflow.
  if (changed.some(isCiFile)) {
    // Or as a planned job whose files are all CI's own: the job's claim,
    // files and proof hold, its journal travels with it, and the review
    // still checks it weakens nothing.
    const named = jobNamed(root, { mb, head, branch, title });
    const j = named && plan.jobs.find(x => x.id === named);
    if (j && isCiJob(j)) {
      pass(`a CI change as job ${j.id}: ${j.goal}`);
      const other = changed.filter(f => !isCiFile(f) && f !== journalPath(j.id) && !(f.startsWith(GOVERNANCE_CHECKS) && matches(j.tests, f)));
      other.length ? fail(`a CI change carries only CI files, its job's journal and checks; also changed: ${other.join(', ')}`) : pass('nothing but CI files, its journal and checks');
      jobFindings(root, { plan, j, mb, head, changed, findings, pass, fail });
      pass('the review checks it weakens nothing that is checked');
      return { ok: findings.every(f => f.ok), mode: 'ci', job: j.id, findings };
    }
    const other = changed.filter(f => !isCiFile(f));
    other.length ? fail(`a CI change carries only CI files; also changed: ${other.join(', ')}`) : pass('a CI change on its own');
    pass('the review checks it weakens nothing that is checked');
    return { ok: findings.every(f => f.ok), mode: 'ci', findings };
  }

  const named = jobNamed(root, { mb, head, branch, title });
  if (!named) {
    fail('the pull request names no job: branch gmod/<job>, or a title "<job>: …"');
    return { ok: false, mode: 'job', findings };
  }
  const j = plan.jobs.find(x => x.id === named);
  if (!j) {
    fail(`${named} isn't a job in the plan on the base: plan it first, in its own pull request`);
    return { ok: false, mode: 'job', job: named, findings };
  }
  pass(`job ${j.id}: ${j.goal}`);
  jobFindings(root, { plan, j, mb, head, changed, findings, pass, fail, evidence: true });
  return { ok: findings.every(f => f.ok), mode: 'job', job: j.id, findings };
}

// What the gate holds every job to: what it waits for is on main, its
// claimant made its commits, it stays in its files (and its journal), and
// its proof: the criteria pass with the change and fail with it put back.
function jobFindings(root, { plan, j, mb, head, changed, findings, pass, fail, evidence = false }) {
  const done = doneJobs(root, mb);
  const waiting = waitsOn(plan, j).filter(d => !done.has(d));
  waiting.length ? fail(`waits for ${waiting.join(', ')}, not yet on main`) : pass('everything it waits for is on main');

  const claim = claims(root)[j.id];
  if (!claim) fail(`nobody claimed ${j.id} (gmod claim ${j.id})`);
  else {
    // The claim is only worth something if the work is the claimant's: their
    // agents commit as them, so their email is on every commit. A merge of
    // main into the branch (the forge's "update branch") brings main's work,
    // not the job's: whoever made it, the files and the proof still judge it.
    const authors = [...new Set(git(['log', '--no-merges', '--format=%ae', `${mb}..${head}`], { cwd: root }).split('\n').filter(Boolean))];
    const others = authors.filter(a => a.toLowerCase() !== String(claim.by).toLowerCase());
    others.length ? fail(`claimed by ${claim.by}, but its commits are by ${others.join(', ')}`) : pass(`claimed by ${claim.by}, who made its commits`);
  }

  const outside = changed.filter(f => !allowed(j, f) && !(evidence && f.startsWith('.gmod/evidence/')) && f !== journalPath(j.id));
  outside.length ? fail(`changes files outside the job: ${outside.join(', ')}`) : pass(`all ${changed.length} changed files are within the job`);

  // The decisions this change falls under: the reviewer answers each one.
  for (const a of applicable(listAdrs(root, { plan, ref: mb }), changed)) {
    const must = a.rules.filter(r => r.level === 'must').map(r => r.text);
    findings.push({ ok: true, info: true, msg: `falls under ADR ${a.id} (${a.title})${must.length ? `: must ${must.join('; must ')}` : ''}` });
  }

  const proof = prove(root, j.id, mb, head, plan);
  for (const s of proof.steps) (s.startsWith('pass') ? pass : fail)(s.replace(/^(pass|FAIL): /, ''));
}

export function report(result) {
  const lines = [`### gmod: ${result.ok ? 'passes' : 'refused'}${result.job ? ` (${result.job})` : ''}`, ''];
  for (const f of result.findings) lines.push(`- ${f.info ? 'ℹ️' : f.ok ? '✅' : '❌'} ${f.msg}`);
  return lines.join('\n');
}

// ---------- proposals: drafting the plan ----------
//
// The agent drafts; a person approves. The draft is a whole plan kept at
// refs/gmod/proposal and pushed to origin (ADR 0002), so every worktree,
// clone and surface sees the same one, until /gmod approve writes it to
// .gmod/plan.json as a commit of its own, or /gmod reject drops it.

const EMPTY_PLAN = { main: 'main', checks: {}, jobs: [] };

const PROPOSAL = 'refs/gmod/proposal';
const PROPOSAL_FILE = 'proposal.json';

// Where 1.6 kept the proposal: carried over to the ref on first read.
const legacyProposal = root => join(resolve(root, git(['rev-parse', '--git-common-dir'], { cwd: root }), 'gmod'), 'proposal.json');

function carryOverProposal(root) {
  const f = legacyProposal(root);
  if (!existsSync(f)) return;
  if (!shared.tip(root, PROPOSAL)) {
    let p = null;
    try { p = JSON.parse(readFileSync(f, 'utf8')); } catch { /* unreadable: nothing to carry */ }
    if (p) shared.writeJson(root, PROPOSAL, PROPOSAL_FILE, p);
  }
  rmSync(f, { force: true });
  bump(root);
}

function planText(root) {
  const f = join(root, PLAN);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

const hash = text => git(['hash-object', '--stdin'], { input: text });

export function proposal(root) {
  carryOverProposal(root);
  const p = shared.readJson(root, PROPOSAL, PROPOSAL_FILE);
  return landed(root, p) ? null : p;
}

// A proposal that has landed: its plan is the plan (on disk, on main or on
// origin's main) while it was drafted against an older one. It was approved;
// a copy left behind (seen in Skiff after a pane approve) is never shown, and
// never pushed back as if it were an edit made offline.
function landed(root, p) {
  if (!p?.plan) return false;
  const main = p.plan.main ?? 'main';
  const texts = [planText(root)];
  for (const ref of [`refs/heads/${main}`, `refs/remotes/origin/${main}`]) {
    const r = git(['show', `${ref}:${PLAN}`], { cwd: root, allow: true });
    if (r.ok) texts.push(r.out + '\n');
  }
  const want = JSON.stringify(canon(p.plan));
  return texts.some(t => {
    if (!t || hash(t) === p.base) return false;
    try { return JSON.stringify(canon(JSON.parse(t))) === want; } catch { return false; }
  });
}

const rawProposal = root => shared.readJson(root, PROPOSAL, PROPOSAL_FILE);

function draft(root) {
  const p = proposal(root);
  if (p) return p;
  const text = planText(root);
  return { by: who(root), at: new Date().toISOString(), base: hash(text), plan: text ? JSON.parse(text) : structuredClone(EMPTY_PLAN) };
}

const RACE = Symbol('race');

function saveDraft(root, p) {
  const problems = validatePlan(p.plan, { draft: true });
  if (problems.length) throw new GmodError(`the draft would not be a valid plan:\n  - ${problems.join('\n  - ')}`);
  if (!shared.writeJson(root, PROPOSAL, PROPOSAL_FILE, p)) return RACE;
  bump(root);
  if (shared.publish(root, PROPOSAL) === 'race') return RACE;
  return { ...p, diff: diffPlans(planFromDisk(root) ?? EMPTY_PLAN, p.plan) };
}

// An edit of the draft as origin has it now. When someone else's edit lands
// first, read again and apply this one on top: never overwrite theirs.
function editDraft(root, edit, { existing = false, none = 'there is no proposal to describe: draft a change first' } = {}) {
  for (let i = 0; i < 8; i++) {
    syncClaims(root);
    if (existing && !proposal(root)) throw new GmodError(none);
    const p = draft(root);
    edit(p);
    const r = saveDraft(root, p);
    if (r !== RACE) return r;
  }
  throw new GmodError('the proposal kept changing under this edit: try again');
}

const JOB_FIELDS = ['goal', 'brief', 'phase', 'files', 'tests', 'done_when', 'after'];
const PHASE_FIELDS = ['title', 'outcome', 'after'];

export function proposeJob(root, job, checks = {}) {
  if (!job?.id) throw new GmodError('a job needs an "id"');
  const clean = Object.fromEntries(Object.entries(job).filter(([k]) => k === 'id' || JOB_FIELDS.includes(k)));
  return editDraft(root, p => {
    const at = p.plan.jobs.findIndex(j => j.id === job.id);
    if (at === -1) p.plan.jobs.push(clean);
    else p.plan.jobs[at] = clean;
    p.plan.checks = { ...p.plan.checks, ...checks };
  });
}

export function editJob(root, id, changes = {}, checks = {}) {
  return editDraft(root, p => {
    const j = p.plan.jobs.find(x => x.id === id);
    if (!j) throw new GmodError(`no job "${id}" in the plan or the draft`);
    for (const [k, v] of Object.entries(changes)) if (JOB_FIELDS.includes(k)) j[k] = v;
    p.plan.checks = { ...p.plan.checks, ...checks };
  });
}

export function dropJob(root, id, reason = '') {
  const plan = planFromDisk(root);
  if (plan?.jobs.some(j => j.id === id)) {
    const s = states(root, plan, { sync: false }).find(x => x.id === id);
    if (s.state === 'done') throw new GmodError(`${id} is done: finished work stays in the plan`);
    if (s.state === 'claimed') throw new GmodError(`${id} is claimed by ${s.by}: they release it first`);
  }
  return editDraft(root, p => {
    if (!p.plan.jobs.some(j => j.id === id)) throw new GmodError(`no job "${id}" in the plan or the draft`);
    const waiting = p.plan.jobs.filter(j => (j.after ?? []).includes(id)).map(j => j.id);
    if (waiting.length) throw new GmodError(`${waiting.join(', ')} wait for ${id}: change them first`);
    p.plan.jobs = p.plan.jobs.filter(j => j.id !== id);
    if (reason) p.reasons = { ...p.reasons, [id]: reason };
  });
}

// Phases: a group of jobs with an outcome, ordered after other phases.
export function proposePhase(root, phase) {
  if (!phase?.id) throw new GmodError('a phase needs an "id"');
  const clean = Object.fromEntries(Object.entries(phase).filter(([k]) => k === 'id' || PHASE_FIELDS.includes(k)));
  return editDraft(root, p => {
    p.plan.phases ??= [];
    const at = p.plan.phases.findIndex(x => x.id === phase.id);
    if (at === -1) p.plan.phases.push(clean);
    else p.plan.phases[at] = clean;
  });
}

export function editPhase(root, id, changes = {}) {
  return editDraft(root, p => {
    const ph = (p.plan.phases ?? []).find(x => x.id === id);
    if (!ph) throw new GmodError(`no phase "${id}" in the plan or the draft`);
    for (const [k, v] of Object.entries(changes)) if (PHASE_FIELDS.includes(k)) ph[k] = v;
  });
}

export function dropPhase(root, id, reason = '') {
  return editDraft(root, p => {
    if (!(p.plan.phases ?? []).some(x => x.id === id)) throw new GmodError(`no phase "${id}" in the plan or the draft`);
    const inside = p.plan.jobs.filter(j => j.phase === id).map(j => j.id);
    if (inside.length) throw new GmodError(`${inside.join(', ')} ${inside.length === 1 ? 'is' : 'are'} in ${id}: move or drop ${inside.length === 1 ? 'it' : 'them'} first`);
    const after = p.plan.phases.filter(x => (x.after ?? []).includes(id)).map(x => x.id);
    if (after.length) throw new GmodError(`${after.join(', ')} come after ${id}: change them first`);
    p.plan.phases = p.plan.phases.filter(x => x.id !== id);
    if (!p.plan.phases.length) delete p.plan.phases;
    if (reason) p.reasons = { ...p.reasons, [`phase:${id}`]: reason };
  });
}

// A person asks for changes: their note waits on the shared proposal for
// whoever drafts it (shown as its asks), wherever the person asked from.
export function askChanges(root, note, { via = 'cli' } = {}) {
  if (!String(note ?? '').trim()) throw new GmodError('say what to change: --note <text>');
  return editDraft(root, p => {
    p.asks = [...(p.asks ?? []), { by: who(root), via, at: new Date().toISOString(), note: String(note).trim() }];
  }, { existing: true, none: 'there is no proposal to ask changes of' });
}

// The draft in a person's words: why it exists, and what it assumes.
// Describing never starts a draft: with none pending (one just approved,
// say), it would leave behind a proposal that changes nothing.
export function describeProposal(root, { summary, assumptions } = {}) {
  return editDraft(root, p => {
    if (summary !== undefined) p.summary = String(summary);
    if (assumptions !== undefined) p.assumptions = (Array.isArray(assumptions) ? assumptions : [assumptions]).map(String).filter(Boolean);
  }, { existing: true });
}

const short = v => {
  const t = Array.isArray(v) ? v.map(x => (typeof x === 'object' ? x.text ?? JSON.stringify(x) : x)).join(' · ') : v == null ? '—' : String(v);
  return t.length > 90 ? `${t.slice(0, 87)}…` : t || '—';
};

const jobCard = j => ({
  id: j.id,
  goal: j.goal,
  phase: j.phase ?? null,
  after: j.after ?? [],
  criteria: j.done_when.map(c => c.text),
  files: j.files.length,
  tests: (j.tests ?? []).length,
  paths: [...j.files, ...(j.tests ?? [])],
});

export function diffPlans(before, after) {
  const was = new Map(before.jobs.map(j => [j.id, j]));
  const now = new Map(after.jobs.map(j => [j.id, j]));
  const added = after.jobs.filter(j => !was.has(j.id)).map(jobCard);
  const dropped = before.jobs.filter(j => !now.has(j.id)).map(j => ({ id: j.id, goal: j.goal }));
  const changed = after.jobs
    .filter(j => was.has(j.id))
    .map(j => {
      const changes = JOB_FIELDS.filter(k => JSON.stringify(j[k] ?? null) !== JSON.stringify(was.get(j.id)[k] ?? null))
        .map(field => ({ field, before: short(was.get(j.id)[field]), after: short(j[field]) }));
      return { ...jobCard(j), fields: changes.map(c => c.field), changes };
    })
    .filter(c => c.fields.length);
  const checks = Object.keys({ ...before.checks, ...after.checks }).filter(k => before.checks?.[k] !== after.checks?.[k]);
  const wasP = new Map((before.phases ?? []).map(x => [x.id, x]));
  const nowP = new Map((after.phases ?? []).map(x => [x.id, x]));
  const phaseCard = x => ({ id: x.id, title: x.title ?? x.id, outcome: x.outcome, after: x.after ?? [] });
  const phases = {
    added: (after.phases ?? []).filter(x => !wasP.has(x.id)).map(phaseCard),
    changed: (after.phases ?? [])
      .filter(x => wasP.has(x.id))
      .map(x => {
        const changes = PHASE_FIELDS.filter(k => JSON.stringify(x[k] ?? null) !== JSON.stringify(wasP.get(x.id)[k] ?? null))
          .map(field => ({ field, before: short(wasP.get(x.id)[field]), after: short(x[field]) }));
        return { ...phaseCard(x), fields: changes.map(c => c.field), changes };
      })
      .filter(c => c.fields.length),
    dropped: (before.phases ?? []).filter(x => !nowP.has(x.id)).map(phaseCard),
  };
  return { added, changed, dropped, checks, phases };
}

// What a person should know before saying yes, worked out from the draft.
function after_(plan) {
  const by = new Map(plan.jobs.map(j => [j.id, waitsOn(plan, j)]));
  const reach = id => {
    const seen = new Set();
    const walk = x => (by.get(x) ?? []).forEach(d => seen.has(d) || (seen.add(d), walk(d)));
    walk(id);
    return seen;
  };
  return new Map(plan.jobs.map(j => [j.id, reach(j.id)]));
}

const prefix = glob => glob.split(/[*?[{]/)[0];
const overlap = (a, b) => a.some(x => b.some(y => prefix(x).startsWith(prefix(y)) || prefix(y).startsWith(prefix(x))));

export function warnings(plan, done = new Set(), touched = null) {
  const out = [];
  const open = plan.jobs.filter(j => !done.has(j.id));
  const deps = after_(plan);
  for (const [i, a] of open.entries()) {
    for (const b of open.slice(i + 1)) {
      if (touched && !touched.has(a.id) && !touched.has(b.id)) continue;
      if (deps.get(a.id).has(b.id) || deps.get(b.id).has(a.id)) continue;
      if (overlap(a.files, b.files)) out.push(`${a.id} and ${b.id} change the same files, so they can't run side by side: order them, or split the files`);
    }
  }
  for (const j of open) {
    if (touched && !touched.has(j.id)) continue;
    if (!(j.tests ?? []).length && !isCiJob(j)) out.push(`${j.id} lists no test files, so CI can't put its code back and keep its tests`);
  }
  return out;
}

export function order(plan, done = new Set()) {
  return plan.jobs.filter(j => !done.has(j.id)).map(j => {
    const waits = waitsOn(plan, j).filter(d => !done.has(d));
    return { id: j.id, phase: j.phase ?? null, after: j.after ?? [], waits, now: waits.length === 0 };
  });
}

export function describeDiff(d) {
  const parts = [];
  const ph = d.phases ?? { added: [], changed: [], dropped: [] };
  if (ph.added.length) parts.push(`add ${ph.added.length === 1 ? 'phase' : 'phases'} ${ph.added.map(x => x.id).join(', ')}`);
  if (ph.changed.length) parts.push(`change ${ph.changed.length === 1 ? 'phase' : 'phases'} ${ph.changed.map(x => x.id).join(', ')}`);
  if (ph.dropped.length) parts.push(`drop ${ph.dropped.length === 1 ? 'phase' : 'phases'} ${ph.dropped.map(x => x.id).join(', ')}`);
  if (d.added.length) parts.push(`add ${d.added.map(j => j.id).join(', ')}`);
  if (d.changed.length) parts.push(`change ${d.changed.map(j => j.id).join(', ')}`);
  if (d.dropped.length) parts.push(`drop ${d.dropped.map(j => j.id).join(', ')}`);
  if (!parts.length && d.checks.length) parts.push(`change checks ${d.checks.join(', ')}`);
  return parts.join('; ') || 'no changes';
}

export function onJobBranch(root) {
  return /^gmod\//.test(git(['branch', '--show-current'], { cwd: root, allow: true }).out);
}

// main's tip, for a decision: local main, or origin's when local is missing
// or behind it.
function mainTip(root, main) {
  const at = ref => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`], { cwd: root, allow: true });
  const local = at(`refs/heads/${main}`);
  const remote = at(`refs/remotes/origin/${main}`);
  if (!local.ok && !remote.ok) throw new GmodError(`there is no ${main} to commit the decision on`);
  if (!local.ok) return remote.out;
  if (remote.ok && git(['merge-base', '--is-ancestor', local.out, remote.out], { cwd: root, allow: true }).ok) return remote.out;
  return local.out;
}

// A decision made from a job's branch: committed on main's tip, in a
// throwaway checkout, so the job's checkout, index and branch stay exactly
// as they were and the decision still travels alone. It gets a branch of its
// own (named by `name`), and local main moves to it when that is a
// fast-forward and main is checked out nowhere.
export function decideOnMain(root, decide, name) {
  const main = planFromDisk(root)?.main ?? 'main';
  const base = mainTip(root, main);
  const dir = mkdtempSync(join(tmpdir(), 'gmod-decide-'));
  try {
    git(['worktree', 'add', '-q', '--detach', dir, base], { cwd: root });
    const r = decide(dir);
    const sha = git(['rev-parse', 'HEAD'], { cwd: dir });
    const commit = git(['rev-parse', '--short', 'HEAD'], { cwd: dir });
    const branch = name(r, commit);
    git(['branch', '-f', branch, sha], { cwd: root });
    const local = git(['rev-parse', '-q', '--verify', `refs/heads/${main}`], { cwd: root, allow: true });
    const checkedOut = git(['worktree', 'list', '--porcelain'], { cwd: root }).split('\n').includes(`branch refs/heads/${main}`);
    if (!checkedOut && (!local.ok || git(['merge-base', '--is-ancestor', local.out, sha], { cwd: root, allow: true }).ok)) {
      git(['update-ref', `refs/heads/${main}`, sha], { cwd: root });
    }
    return { ...r, commit, sha, branch };
  } finally {
    git(['worktree', 'remove', '--force', dir], { cwd: root, allow: true });
    rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'prune'], { cwd: root, allow: true });
  }
}

// A person's decision. The plan is committed alone: on the branch the person
// is on, or, from a job's branch, on main's tip without touching the job.
// Who made a person's decision, and through which surface (the pane, the
// CLI, Skiff, Linear…): trailers on its commit, so the record says (ADR 0002).
export function decidedBy(root, via = 'cli') {
  return ['', `Decided-By: ${who(root)}`, `Decided-Via: ${via}`].join('\n');
}

export function approve(root, { via = 'cli' } = {}) {
  syncClaims(root);
  if (onJobBranch(root)) return decideOnMain(root, dir => commitPlan(dir, via), (_, commit) => `gmod/plan-${commit}`);
  return commitPlan(root, via);
}

function commitPlan(root, via = 'cli') {
  const p = proposal(root);
  if (!p) throw new GmodError('there is no proposal to approve');
  if (hash(planText(root)) !== p.base) throw new GmodError(`${PLAN} changed since the proposal was drafted: reject it and draft again`);
  if (changesNothing(root, p)) throw new GmodError('the proposal changes nothing: reject it');
  const branch = git(['branch', '--show-current'], { cwd: root, allow: true }).out;
  const problems = validatePlan(p.plan);
  if (problems.length) throw new GmodError(`the proposal isn't a valid plan:\n  - ${problems.join('\n  - ')}`);
  const summary = describeDiff(diffPlans(planFromDisk(root) ?? EMPTY_PLAN, p.plan));
  // Taken down everywhere first: if it changed since it was read, the person
  // looks again rather than approve a version they didn't see.
  if (!shared.unpublish(root, PROPOSAL)) throw new GmodError('the proposal changed a moment ago: look at it again');
  mkdirSync(join(root, '.gmod'), { recursive: true });
  writeFileSync(join(root, PLAN), JSON.stringify(p.plan, null, 2) + '\n');
  git(['add', '--', PLAN], { cwd: root });
  git(['commit', '-q', '-m', `plan: ${summary}\n${decidedBy(root, via)}`, '--', PLAN], { cwd: root });
  bump(root);
  return { summary, commit: git(['rev-parse', '--short', 'HEAD'], { cwd: root }), sha: git(['rev-parse', 'HEAD'], { cwd: root }), branch };
}

// The same plan, whatever order its keys were written in.
// A proposal's content, as a short hash: the same on every clone, new on every edit.
const proposalRev = p => createHash('sha256')
  .update(JSON.stringify(canon({ plan: p.plan, summary: p.summary ?? '', assumptions: p.assumptions ?? [], reasons: p.reasons ?? {} })))
  .digest('hex').slice(0, 12);

const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);

// A proposal whose plan is the plan as it stands: nothing to approve.
function changesNothing(root, p) {
  return JSON.stringify(canon(p.plan)) === JSON.stringify(canon(planFromDisk(root) ?? EMPTY_PLAN));
}

export function reject(root, reason = '') {
  syncClaims(root);
  const p = proposal(root);
  if (!p) throw new GmodError('there is no proposal to reject');
  if (!shared.unpublish(root, PROPOSAL)) throw new GmodError('the proposal changed a moment ago: look at it again');
  bump(root);
  return { summary: describeDiff(diffPlans(planFromDisk(root) ?? EMPTY_PLAN, p.plan)), reason };
}

// ---------- status, for the pane and the prompt ----------

function proposalView(root, plan, done) {
  const p = proposal(root);
  if (!p) return null;
  const diff = diffPlans(plan ?? EMPTY_PLAN, p.plan);
  diff.dropped = diff.dropped.map(d => ({ ...d, reason: p.reasons?.[d.id] ?? '' }));
  diff.phases.dropped = diff.phases.dropped.map(d => ({ ...d, reason: p.reasons?.[`phase:${d.id}`] ?? '' }));
  const touched = new Set([...diff.added, ...diff.changed].map(j => j.id));
  const stale = hash(planText(root)) !== p.base;
  const empty = changesNothing(root, p);
  return {
    by: p.by,
    at: p.at,
    // This version of it: what a person sees (the plan, why, what it assumes,
    // why things are dropped), so a decision can name the version it is about.
    rev: proposalRev(p),
    // What a person asked to change, oldest first.
    asks: p.asks ?? [],
    summary: describeDiff(diff),
    headline: p.summary ?? '',
    assumptions: p.assumptions ?? [],
    diff,
    order: order(p.plan, done).filter(o => touched.has(o.id) || o.after.some(a => touched.has(a))),
    warnings: [...(stale ? [`${PLAN} changed since this was drafted: reject it and draft again`] : []), ...(empty ? ['the proposal changes nothing: reject it'] : []), ...unfinished(p.plan).map(u => `not ready to approve: ${u}`), ...warnings(p.plan, done, touched)],
    ready: !stale && !empty && unfinished(p.plan).length === 0,
    stale,
  };
}

// Where every job stands, across every worktree of this repository: the
// stage track the pane draws. claim → red → green → commit → push → merge.
export const STAGES = ['claim', 'red', 'green', 'commit', 'push', 'merge'];

function worktrees(root) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd: root, allow: true }).out;
  return out.split('\n\n').map(block => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    return path && existsSync(path) ? { path, branch } : null;
  }).filter(Boolean);
}

export function board(root, plan, opts) {
  const outer = stateDirs;
  stateDirs ??= new Map();
  try {
    return readBoard(root, plan, opts);
  } finally {
    stateDirs = outer;
  }
}

function readBoard(root, plan, { sync = false } = {}) {
  if (sync) {
    syncClaims(root);
    syncMain(root, plan);
  }
  const main = mainRef(root, plan);
  const done = doneJobs(root, main);
  const held = claims(root);
  const here = realpathSync(root);
  const decisions = listAdrs(root, { plan });
  const local = new Map();
  // Worktrees an agent made get short names (agent 1, agent 2) in the order
  // git lists them; a person's own keep their folder's name.
  let agents = 0;
  for (const wt of worktrees(root)) {
    const name = realpathSync(wt.path) === here ? 'here' : /^agent-[0-9a-f]{6,}$/.test(wt.path.split('/').pop()) ? `agent ${++agents}` : wt.path.split('/').pop();
    const c = current(wt.path);
    if (!c) continue;
    const ev = proof(wt.path, plan, c.job, c.at);
    const last = ev.at(-1);
    // A leftover worktree of a job that already landed: its commit, push and
    // place against main no longer matter (the job reads as done), so git
    // isn't asked about them. Agents leave many of these behind.
    const landed = done.has(c.job);
    const commit = landed ? undefined : git(['log', '--format=%H %s', `${main}..HEAD`], { cwd: wt.path, allow: true }).out
      .split('\n').find(l => l.slice(41).startsWith(`${c.job}:`))?.slice(0, 40);
    const remote = `refs/remotes/origin/gmod/${c.job}`;
    const pushed = !!commit && git(['merge-base', '--is-ancestor', commit, remote], { cwd: wt.path, allow: true }).ok;
    local.set(c.job, {
      where: name,
      path: wt.path,
      sawRed: ev.some(r => r.result === 'red'),
      green: last?.result === 'green',
      runs: ev.length,
      criteria: last ? last.results.map(r => ({ text: r.criterion, pass: r.pass })) : [],
      commit: !!commit,
      pushed,
      // Against main, from what's already known: the checks themselves run
      // in the background (gmod moved --run).
      moved: landed ? null : movedFor(wt.path, plan, { main, done }),
      journal: journal(wt.path, c.job).slice(-5),
    });
  }
  return plan.jobs.map(j => {
    const waiting = waitsOn(plan, j).filter(d => !done.has(d));
    const mine = local.get(j.id);
    const claimed = !!held[j.id] || !!mine;
    const state = done.has(j.id) ? 'done' : claimed ? 'claimed' : waiting.length ? 'waiting' : 'ready';
    // Worked on another machine: what its latest shared verdict says.
    const there = state === 'claimed' && !mine ? verdictFor(root, plan, j, held[j.id]) : null;
    let stage = 0;
    if (state === 'done') stage = 6;
    else if (claimed) {
      stage = 1;
      if (mine?.sawRed) stage = 2;
      if (mine?.sawRed && mine.green) stage = 3;
      if (mine?.commit) stage = 4;
      if (mine?.pushed) stage = 5;
      if (there) stage = there.pass ? 3 : 2;
    }
    return {
      id: j.id,
      goal: j.goal,
      state,
      stage,
      stalled: (!!mine && mine.runs > 0 && !mine.green && stage === 2) || (!!there && !there.pass),
      // The test step in one word: none run yet, failing, passing after a
      // failure, or passing without ever failing (which proves nothing).
      tests: state === 'done' ? 'green' : there ? (there.pass ? 'green' : 'red') : !mine || mine.runs === 0 ? 'none' : !mine.green ? 'red' : mine.sawRed ? 'green' : 'unproven',
      by: held[j.id]?.by,
      where: mine?.where ?? (held[j.id] ? 'elsewhere' : null),
      waiting,
      after: j.after ?? [],
      phase: j.phase ?? null,
      moved: mine?.moved ? { level: mine.moved.level, behind: mine.moved.behind, landed: mine.moved.landed, changed: mine.moved.changed ?? [], touched: mine.moved.touched, conflicts: mine.moved.conflicts, failing: mine.moved.failing } : null,
      criteria: mine?.criteria.length ? mine.criteria : j.done_when.map(c => ({ text: c.text, pass: there ? !there.failing.includes(c.text) : null })),
      files: [...j.files, ...(j.tests ?? [])],
      adrs: applicable(decisions, [...j.files, ...(j.tests ?? [])]).map(a => ({ id: a.id, title: a.title, rules: a.rules })),
      journal: mine?.journal ?? journal(root, j.id).slice(-5),
    };
  });
}

// Each phase as the pane shows it: its jobs' progress, and where it stands.
// done: every job on main · active: a job claimed · ready: may start ·
// waiting: a phase before it isn't done.
export function phaseStates(plan, jobs) {
  const by = new Map(jobs.map(j => [j.id, j]));
  const finished = new Set();
  const out = (plan.phases ?? []).map(ph => {
    const mine = plan.jobs.filter(j => j.phase === ph.id).map(j => by.get(j.id)).filter(Boolean);
    const done = mine.filter(j => j.state === 'done').length;
    if (mine.length && done === mine.length) finished.add(ph.id);
    return { ph, mine, done };
  });
  return out.map(({ ph, mine, done }) => {
    const waiting = (ph.after ?? []).filter(d => !finished.has(d));
    const state = mine.length && done === mine.length ? 'done' : mine.some(j => j.state === 'claimed') ? 'active' : waiting.length ? 'waiting' : 'ready';
    return {
      id: ph.id,
      title: ph.title ?? ph.id,
      outcome: ph.outcome,
      after: ph.after ?? [],
      waiting,
      state,
      jobs: mine.map(j => j.id),
      done,
      total: mine.length,
      moving: mine.filter(j => j.state === 'claimed').length,
      stalled: mine.some(j => j.stalled),
    };
  });
}

export function status(root, { sync = false } = {}) {
  const plan = planFromDisk(root);
  if (!plan) return { governed: false, proposal: proposalView(root, null, new Set()) };
  const mine = current(root);
  const j = mine && plan.jobs.find(x => x.id === mine.job);
  const ev = mine ? proof(root, plan, mine.job, mine.at) : [];
  const jobs = board(root, plan, { sync });
  const done = new Set(jobs.filter(x => x.state === 'done').map(x => x.id));
  return {
    governed: true,
    root,
    phases: phaseStates(plan, jobs),
    requests: openRequests(root),
    adrDrafts: adrDrafts(root).map(d => ({ draft: d.draft, title: d.title, context: d.context ?? '', decision: d.decision, scope: d.scope, rules: d.rules, supersedes: d.supersedes, by: d.by })),
    proposal: proposalView(root, plan, done),
    claim: j
      ? {
          job: j.id,
          goal: j.goal,
          files: [...j.files, ...(j.tests ?? [])],
          done_when: j.done_when.map(c => c.text),
          brief: j.brief,
          adrs: applicable(listAdrs(root, { plan }), [...j.files, ...(j.tests ?? [])]).map(a => ({ id: a.id, title: a.title, rules: a.rules })),
        }
      : null,
    evidence: ev.slice(-6).map(r => ({ result: r.result, at: r.at, failed: r.results.filter(x => !x.pass).map(x => x.criterion) })),
    sawRed: ev.some(r => r.result === 'red'),
    gate: mine ? gateCommit(root) : null,
    jobs,
    next: jobs.find(s => s.state === 'ready')?.id ?? null,
  };
}

// ---------- init ----------

export function init(root) {
  const file = join(root, PLAN);
  if (existsSync(file)) throw new GmodError(`${PLAN} already exists`);
  mkdirSync(join(root, '.gmod'), { recursive: true });
  const starter = {
    main: 'main',
    adr_dir: 'docs/adr',
    checks: { test: 'npm test' },
    jobs: [{
      id: 'first-job',
      goal: 'Say in one sentence what this work achieves',
      brief: 'A few sentences of context: where, what, what not.',
      files: ['src/**'],
      tests: ['test/**'],
      done_when: [{ text: 'A criterion a check can prove', check: 'test' }],
      after: [],
    }],
  };
  writeFileSync(file, JSON.stringify(starter, null, 2) + '\n');
  return { file: PLAN };
}

// gmod core: everything the mod, a person at a terminal and CI share.
// Zero dependencies: node >= 20 and git.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { adrDir, applicable, drafts as adrDrafts, listAdrs } from './adr.mjs';

export const PLAN = '.gmod/plan.json';
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

function stateDir(root) {
  const dir = resolve(root, git(['rev-parse', '--git-dir'], { cwd: root }), 'gmod');
  mkdirSync(join(dir, 'evidence'), { recursive: true });
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

export function syncClaims(root) {
  if (!hasOrigin(root)) return false;
  return git(['fetch', '-q', '--prune', 'origin', `+${CLAIMS}*:${CLAIMS}*`], { cwd: root, allow: true }).ok;
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
  return git(['fetch', '-q', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`], { cwd: root, allow: true }).ok;
}

const movedFile = root => join(stateDir(root), 'moved.json');
const toldFile = root => join(stateDir(root), 'told.json');
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);

export function movedFor(root, plan, { run = false } = {}) {
  const c = current(root);
  const j = c && plan.jobs.find(x => x.id === c.job);
  if (!j) return null;
  const main = mainRef(root, plan);
  if (main === 'HEAD') return { job: j.id, level: 'fresh', behind: 0, landed: [], touched: [], conflicts: [], failing: [], checked: false };
  const tip = git(['rev-parse', main], { cwd: root });
  const base = git(['merge-base', 'HEAD', main], { cwd: root, allow: true }).out;
  const out = { job: j.id, level: 'fresh', behind: 0, landed: [], changed: [], touched: [], conflicts: [], failing: [], checked: false, tip };
  // A job that has landed is done: its leftover claim isn't checked.
  if (doneJobs(root, main).has(j.id)) return null;
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

export function claim(root, id, { branch = true } = {}) {
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
    throw new GmodError(`${id} is claimed by ${s.by}`);
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
  let note = '';
  if (branch) {
    const name = `gmod/${id}`;
    const dirty = git(['status', '--porcelain'], { cwd: root }).length > 0;
    const exists = git(['rev-parse', '-q', '--verify', `refs/heads/${name}`], { cwd: root, allow: true }).ok;
    const r = git(exists ? ['switch', '-q', name] : ['switch', '-q', '-c', name], { cwd: root, allow: true });
    note = r.ok ? `on branch ${name}` : `stay on your branch (${dirty ? 'uncommitted changes' : r.err}); name the pull request "${id}: …"`;
  }
  return { ...info, note };
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
  return { job: id };
}

// ---------- checks and evidence ----------

// The worktree as a tree id, untracked files included: what a commit of
// "everything" would hold. Equal ids mean nothing changed in between.
export function fingerprint(root) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-idx-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    git(['read-tree', 'HEAD'], { cwd: root, env, allow: true });
    git(['add', '-A', '--', '.', ':(exclude).gmod/evidence'], { cwd: root, env });
    return git(['write-tree'], { cwd: root, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runChecks(dir, plan, j) {
  const results = [];
  for (const c of j.done_when) {
    const cmd = plan.checks[c.check];
    const r = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 << 20 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    results.push({ criterion: c.text, check: c.check, pass: r.status === 0, tail: out.split('\n').slice(-15).join('\n').trim() });
  }
  return results;
}

export function check(root, id) {
  const plan = planFromDisk(root);
  id ??= current(root)?.job;
  if (!id) throw new GmodError('claim a job first, or name one');
  const j = job(plan, id);
  const results = runChecks(root, plan, j);
  const green = results.every(r => r.pass);
  const record = { result: green ? 'green' : 'red', fingerprint: fingerprint(root), at: new Date().toISOString(), results };
  const all = [...evidence(root, id), record].slice(-50);
  writeFileSync(evidenceFile(root, id), JSON.stringify(all, null, 2));
  return { job: id, ...record, sawRed: all.some(r => r.result === 'red') };
}

// What a commit needs: a claim, a red seen first, and a green on exactly
// what is about to be committed.
export function gateCommit(root) {
  const mine = current(root);
  if (!planFromDisk(root)) return { ok: true, reason: 'no plan here: not governed' };
  if (!mine) return { ok: false, reason: 'claim a job first (gmod claim <job>)' };
  const ev = evidence(root, mine.job).filter(r => r.at >= mine.at);
  if (!ev.some(r => r.result === 'red')) {
    return { ok: false, reason: `${mine.job}: no failing run recorded before it passed: run gmod check while the criteria still fail` };
  }
  const plan = planFromDisk(root);
  const m = movedFor(root, plan);
  if (m?.level === 'breaks') {
    return { ok: false, reason: `${mine.job}: ${m.failing.map(f => `"${f}"`).join(' and ')} ${m.failing.length === 1 ? 'fails' : 'fail'} on today's main (${m.landed.join(', ') || 'main'} changed ${(m.touched.length ? m.touched : m.changed).slice(0, 3).join(', ')}): rebase onto origin/main, fix it, then gmod check` };
  }
  const last = ev.at(-1);
  if (last.result !== 'green') return { ok: false, reason: `${mine.job}: the last check failed: make it pass, then gmod check` };
  if (last.fingerprint !== fingerprint(root)) return { ok: false, reason: `${mine.job}: files changed since the last passing check: run gmod check again` };
  return { ok: true, reason: `${mine.job}: failed first, passes on exactly these files` };
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
    steps.push(`${headOk ? 'pass' : 'FAIL'}: the criteria pass with the change (${atHead.filter(r => r.pass).length}/${atHead.length})`);
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
    git(['worktree', 'remove', '--force', wt], { cwd: root, allow: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- verify: the CI gate ----------

// The files that make up CI itself: workflows and who owns what.
const CI_FILES = ['.github/workflows/**', '.gitea/workflows/**', '.github/CODEOWNERS', '.gitea/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
export const isCiFile = f => matches(CI_FILES, f);

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

  if (changed.includes(PLAN)) {
    const other = changed.filter(f => !f.startsWith('.gmod/') && !(adr && f.startsWith(adr)));
    other.length ? fail(`a plan change carries only the plan (and ADRs); also changed: ${other.join(', ')}`) : pass('a plan change on its own');
    try {
      planAt(root, head);
      pass('the new plan is valid');
    } catch (e) {
      fail(e.message);
    }
    pass("the plan's owners approve it on the pull request (CODEOWNERS on .gmod/)");
    return { ok: findings.every(f => f.ok), mode: 'plan', findings };
  }

  // A decision record changes on its own, for the owners to review.
  const adrPrefix = `${adrDir(plan)}/`;
  if (changed.some(f => f.startsWith(adrPrefix))) {
    const other = changed.filter(f => !f.startsWith(adrPrefix));
    other.length ? fail(`a decision record travels alone; also changed: ${other.join(', ')}`) : pass('a decision record on its own');
    pass("the repository's owners review decisions (CODEOWNERS)");
    return { ok: findings.every(f => f.ok), mode: 'adr', findings };
  }

  // CI's own files change on their own, like the plan, and the owners review
  // them: a pull request runs its own copy of the workflow.
  if (changed.some(isCiFile)) {
    const other = changed.filter(f => !isCiFile(f));
    other.length ? fail(`a CI change carries only CI files; also changed: ${other.join(', ')}`) : pass('a CI change on its own');
    pass("the repository's owners review CI changes (CODEOWNERS)");
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

  const done = doneJobs(root, mb);
  const waiting = waitsOn(plan, j).filter(d => !done.has(d));
  waiting.length ? fail(`waits for ${waiting.join(', ')}, not yet on main`) : pass('everything it waits for is on main');

  const claim = claims(root)[j.id];
  if (!claim) fail(`nobody claimed ${j.id} (gmod claim ${j.id})`);
  else {
    // The claim is only worth something if the work is the claimant's: their
    // agents commit as them, so their email is on every commit.
    const authors = [...new Set(git(['log', '--format=%ae', `${mb}..${head}`], { cwd: root }).split('\n').filter(Boolean))];
    const others = authors.filter(a => a.toLowerCase() !== String(claim.by).toLowerCase());
    others.length ? fail(`claimed by ${claim.by}, but its commits are by ${others.join(', ')}`) : pass(`claimed by ${claim.by}, who made its commits`);
  }

  const outside = changed.filter(f => !allowed(j, f) && !f.startsWith('.gmod/evidence/'));
  outside.length ? fail(`changes files outside the job: ${outside.join(', ')}`) : pass(`all ${changed.length} changed files are within the job`);

  // The decisions this change falls under: the reviewer answers each one.
  for (const a of applicable(listAdrs(root, { plan, ref: mb }), changed)) {
    const must = a.rules.filter(r => r.level === 'must').map(r => r.text);
    findings.push({ ok: true, info: true, msg: `falls under ADR ${a.id} (${a.title})${must.length ? `: must ${must.join('; must ')}` : ''}` });
  }

  const proof = prove(root, j.id, mb, head, plan);
  for (const s of proof.steps) (s.startsWith('pass') ? pass : fail)(s.replace(/^(pass|FAIL): /, ''));
  return { ok: findings.every(f => f.ok), mode: 'job', job: j.id, findings };
}

export function report(result) {
  const lines = [`### gmod: ${result.ok ? 'passes' : 'refused'}${result.job ? ` (${result.job})` : ''}`, ''];
  for (const f of result.findings) lines.push(`- ${f.info ? 'ℹ️' : f.ok ? '✅' : '❌'} ${f.msg}`);
  return lines.join('\n');
}

// ---------- proposals: drafting the plan ----------
//
// The agent drafts; a person approves. The draft is a whole plan kept in the
// git directory, shared by every worktree, until /gmod approve writes it to
// .gmod/plan.json as a commit of its own, or /gmod reject drops it.

const EMPTY_PLAN = { main: 'main', checks: {}, jobs: [] };

function proposalFile(root) {
  const dir = resolve(root, git(['rev-parse', '--git-common-dir'], { cwd: root }), 'gmod');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'proposal.json');
}

function planText(root) {
  const f = join(root, PLAN);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

const hash = text => git(['hash-object', '--stdin'], { input: text });

export function proposal(root) {
  const f = proposalFile(root);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

function draft(root) {
  const p = proposal(root);
  if (p) return p;
  const text = planText(root);
  return { by: who(root), at: new Date().toISOString(), base: hash(text), plan: text ? JSON.parse(text) : structuredClone(EMPTY_PLAN) };
}

function saveDraft(root, p) {
  const problems = validatePlan(p.plan, { draft: true });
  if (problems.length) throw new GmodError(`the draft would not be a valid plan:\n  - ${problems.join('\n  - ')}`);
  writeFileSync(proposalFile(root), JSON.stringify(p, null, 2));
  return { ...p, diff: diffPlans(planFromDisk(root) ?? EMPTY_PLAN, p.plan) };
}

const JOB_FIELDS = ['goal', 'brief', 'phase', 'files', 'tests', 'done_when', 'after'];
const PHASE_FIELDS = ['title', 'outcome', 'after'];

export function proposeJob(root, job, checks = {}) {
  if (!job?.id) throw new GmodError('a job needs an "id"');
  const p = draft(root);
  const clean = Object.fromEntries(Object.entries(job).filter(([k]) => k === 'id' || JOB_FIELDS.includes(k)));
  const at = p.plan.jobs.findIndex(j => j.id === job.id);
  if (at === -1) p.plan.jobs.push(clean);
  else p.plan.jobs[at] = clean;
  p.plan.checks = { ...p.plan.checks, ...checks };
  return saveDraft(root, p);
}

export function editJob(root, id, changes = {}, checks = {}) {
  const p = draft(root);
  const j = p.plan.jobs.find(x => x.id === id);
  if (!j) throw new GmodError(`no job "${id}" in the plan or the draft`);
  for (const [k, v] of Object.entries(changes)) if (JOB_FIELDS.includes(k)) j[k] = v;
  p.plan.checks = { ...p.plan.checks, ...checks };
  return saveDraft(root, p);
}

export function dropJob(root, id, reason = '') {
  const p = draft(root);
  const plan = planFromDisk(root);
  if (plan?.jobs.some(j => j.id === id)) {
    const s = states(root, plan, { sync: false }).find(x => x.id === id);
    if (s.state === 'done') throw new GmodError(`${id} is done: finished work stays in the plan`);
    if (s.state === 'claimed') throw new GmodError(`${id} is claimed by ${s.by}: they release it first`);
  }
  if (!p.plan.jobs.some(j => j.id === id)) throw new GmodError(`no job "${id}" in the plan or the draft`);
  const waiting = p.plan.jobs.filter(j => (j.after ?? []).includes(id)).map(j => j.id);
  if (waiting.length) throw new GmodError(`${waiting.join(', ')} wait for ${id}: change them first`);
  p.plan.jobs = p.plan.jobs.filter(j => j.id !== id);
  if (reason) p.reasons = { ...p.reasons, [id]: reason };
  return saveDraft(root, p);
}

// Phases: a group of jobs with an outcome, ordered after other phases.
export function proposePhase(root, phase) {
  if (!phase?.id) throw new GmodError('a phase needs an "id"');
  const p = draft(root);
  const clean = Object.fromEntries(Object.entries(phase).filter(([k]) => k === 'id' || PHASE_FIELDS.includes(k)));
  p.plan.phases ??= [];
  const at = p.plan.phases.findIndex(x => x.id === phase.id);
  if (at === -1) p.plan.phases.push(clean);
  else p.plan.phases[at] = clean;
  return saveDraft(root, p);
}

export function editPhase(root, id, changes = {}) {
  const p = draft(root);
  const ph = (p.plan.phases ?? []).find(x => x.id === id);
  if (!ph) throw new GmodError(`no phase "${id}" in the plan or the draft`);
  for (const [k, v] of Object.entries(changes)) if (PHASE_FIELDS.includes(k)) ph[k] = v;
  return saveDraft(root, p);
}

export function dropPhase(root, id, reason = '') {
  const p = draft(root);
  if (!(p.plan.phases ?? []).some(x => x.id === id)) throw new GmodError(`no phase "${id}" in the plan or the draft`);
  const inside = p.plan.jobs.filter(j => j.phase === id).map(j => j.id);
  if (inside.length) throw new GmodError(`${inside.join(', ')} ${inside.length === 1 ? 'is' : 'are'} in ${id}: move or drop ${inside.length === 1 ? 'it' : 'them'} first`);
  const after = p.plan.phases.filter(x => (x.after ?? []).includes(id)).map(x => x.id);
  if (after.length) throw new GmodError(`${after.join(', ')} come after ${id}: change them first`);
  p.plan.phases = p.plan.phases.filter(x => x.id !== id);
  if (!p.plan.phases.length) delete p.plan.phases;
  if (reason) p.reasons = { ...p.reasons, [`phase:${id}`]: reason };
  return saveDraft(root, p);
}

// The draft in a person's words: why it exists, and what it assumes.
export function describeProposal(root, { summary, assumptions } = {}) {
  const p = draft(root);
  if (summary !== undefined) p.summary = String(summary);
  if (assumptions !== undefined) p.assumptions = (Array.isArray(assumptions) ? assumptions : [assumptions]).map(String).filter(Boolean);
  return saveDraft(root, p);
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
    if (!(j.tests ?? []).length) out.push(`${j.id} lists no test files, so CI can't put its code back and keep its tests`);
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

// A person's decision. The plan is committed alone, never on a job's branch.
export function approve(root) {
  const p = proposal(root);
  if (!p) throw new GmodError('there is no proposal to approve');
  if (hash(planText(root)) !== p.base) throw new GmodError(`${PLAN} changed since the proposal was drafted: reject it and draft again`);
  const branch = git(['branch', '--show-current'], { cwd: root, allow: true }).out;
  if (/^gmod\//.test(branch)) throw new GmodError(`you're on ${branch}, a job's branch: a plan change travels alone, so switch to main (or a plan branch) first`);
  const problems = validatePlan(p.plan);
  if (problems.length) throw new GmodError(`the proposal isn't a valid plan:\n  - ${problems.join('\n  - ')}`);
  const summary = describeDiff(diffPlans(planFromDisk(root) ?? EMPTY_PLAN, p.plan));
  mkdirSync(join(root, '.gmod'), { recursive: true });
  writeFileSync(join(root, PLAN), JSON.stringify(p.plan, null, 2) + '\n');
  git(['add', '--', PLAN], { cwd: root });
  git(['commit', '-q', '-m', `plan: ${summary}`, '--', PLAN], { cwd: root });
  rmSync(proposalFile(root), { force: true });
  return { summary, commit: git(['rev-parse', '--short', 'HEAD'], { cwd: root }), branch };
}

export function reject(root, reason = '') {
  const p = proposal(root);
  if (!p) throw new GmodError('there is no proposal to reject');
  rmSync(proposalFile(root), { force: true });
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
  return {
    by: p.by,
    at: p.at,
    summary: describeDiff(diff),
    headline: p.summary ?? '',
    assumptions: p.assumptions ?? [],
    diff,
    order: order(p.plan, done).filter(o => touched.has(o.id) || o.after.some(a => touched.has(a))),
    warnings: [...(stale ? [`${PLAN} changed since this was drafted: reject it and draft again`] : []), ...unfinished(p.plan).map(u => `not ready to approve: ${u}`), ...warnings(p.plan, done, touched)],
    ready: !stale && unfinished(p.plan).length === 0,
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

export function board(root, plan, { sync = false } = {}) {
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
    const ev = evidence(wt.path, c.job).filter(r => r.at >= c.at);
    const last = ev.at(-1);
    const commit = git(['log', '--format=%H %s', `${main}..HEAD`], { cwd: wt.path, allow: true }).out
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
      moved: movedFor(wt.path, plan),
    });
  }
  return plan.jobs.map(j => {
    const waiting = waitsOn(plan, j).filter(d => !done.has(d));
    const mine = local.get(j.id);
    const claimed = !!held[j.id] || !!mine;
    const state = done.has(j.id) ? 'done' : claimed ? 'claimed' : waiting.length ? 'waiting' : 'ready';
    let stage = 0;
    if (state === 'done') stage = 6;
    else if (claimed) {
      stage = 1;
      if (mine?.sawRed) stage = 2;
      if (mine?.sawRed && mine.green) stage = 3;
      if (mine?.commit) stage = 4;
      if (mine?.pushed) stage = 5;
    }
    return {
      id: j.id,
      goal: j.goal,
      state,
      stage,
      stalled: !!mine && mine.runs > 0 && !mine.green && stage === 2,
      // The test step in one word: none run yet, failing, passing after a
      // failure, or passing without ever failing (which proves nothing).
      tests: state === 'done' ? 'green' : !mine || mine.runs === 0 ? 'none' : !mine.green ? 'red' : mine.sawRed ? 'green' : 'unproven',
      by: held[j.id]?.by,
      where: mine?.where ?? (held[j.id] ? 'elsewhere' : null),
      waiting,
      after: j.after ?? [],
      phase: j.phase ?? null,
      moved: mine?.moved ? { level: mine.moved.level, behind: mine.moved.behind, landed: mine.moved.landed, changed: mine.moved.changed ?? [], touched: mine.moved.touched, conflicts: mine.moved.conflicts, failing: mine.moved.failing } : null,
      criteria: mine?.criteria.length ? mine.criteria : j.done_when.map(c => ({ text: c.text, pass: null })),
      files: [...j.files, ...(j.tests ?? [])],
      adrs: applicable(decisions, [...j.files, ...(j.tests ?? [])]).map(a => ({ id: a.id, title: a.title, rules: a.rules })),
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
  const ev = mine ? evidence(root, mine.job).filter(r => r.at >= mine.at) : [];
  const jobs = board(root, plan, { sync });
  const done = new Set(jobs.filter(x => x.state === 'done').map(x => x.id));
  return {
    governed: true,
    root,
    phases: phaseStates(plan, jobs),
    adrDrafts: adrDrafts(root).map(d => ({ draft: d.draft, title: d.title, decision: d.decision, scope: d.scope, rules: d.rules, supersedes: d.supersedes, by: d.by })),
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

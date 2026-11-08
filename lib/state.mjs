// gmod state: the plan and its progress as one record, for faces (Skiff) that
// read gmod without its pane. Read-only: it is built from what the pane
// already shows (core.board, core.phaseStates) and main's history, and writes
// nothing. The shape is protocol v1, as Skiff's recorded fixtures define it:
//   { v: 1, project, plan: { v, phases, backlog }, jobs, activity }
// Readers ignore fields they don't know, so gmod's own words (stage, tests,
// by, where) ride along on each job.
import { basename, dirname, resolve } from 'node:path';
import { board, git, GmodError, PLAN, phaseStates, planFromDisk } from './core.mjs';

export const STATE_VERSION = 1;

// The job states a face knows, from the pane's: a job done on main is proven
// (its "<job>:" commit landed, which only a passing gate lets through).
function jobState(j) {
  if (j.state === 'done') return 'proven';
  if (j.state === 'claimed') return j.stalled ? 'stuck' : 'working';
  return j.state; // ready, waiting
}

// Where main is, as core reads it: origin's copy first, then the local branch.
function mainRef(root, plan) {
  const main = plan.main ?? 'main';
  for (const ref of [`refs/remotes/origin/${main}`, `refs/heads/${main}`]) {
    if (git(['rev-parse', '-q', '--verify', ref], { cwd: root, allow: true }).ok) return ref;
  }
  return 'HEAD';
}

// Each job's landing on main, newest first: the newest "<job>:" commit of a
// job in the plan.
function landings(root, plan) {
  const ids = new Set(plan.jobs.map(j => j.id));
  const r = git(['log', '--format=%H%x00%cI%x00%s', mainRef(root, plan)], { cwd: root, allow: true });
  const seen = new Map();
  for (const line of r.ok ? r.out.split('\n') : []) {
    const [sha, at, subject] = line.split('\0');
    const id = subject?.match(/^([a-z0-9][a-z0-9._-]*):/)?.[1];
    if (id && ids.has(id) && !seen.has(id)) seen.set(id, { id, sha, at, subject });
  }
  return [...seen.values()];
}

// The repository's name: the folder of its main checkout, so every worktree
// of it reports the same project.
function projectName(root) {
  const common = git(['rev-parse', '--git-common-dir'], { cwd: root, allow: true });
  if (!common.ok) return basename(root);
  const dir = resolve(root, common.out);
  return basename(basename(dir) === '.git' ? dirname(dir) : dir.replace(/\.git$/, ''));
}

export function state(root, { sync = false } = {}) {
  const plan = planFromDisk(root);
  if (!plan) throw new GmodError(`no ${PLAN} here (gmod init)`);
  const jobs = board(root, plan, { sync });
  const phases = phaseStates(plan, jobs);
  const landed = landings(root, plan);
  const when = new Map(landed.map(l => [l.id, l.at]));
  const byId = new Map(plan.jobs.map(j => [j.id, j]));
  return {
    v: STATE_VERSION,
    project: projectName(root),
    plan: {
      v: plan.v ?? 1,
      phases: phases.map(ph => ({
        id: ph.id,
        title: ph.title,
        outcome: ph.outcome,
        after: ph.after,
        state: ph.state,
        jobs: ph.jobs,
        done: ph.done,
        total: ph.total,
      })),
      // gmod has no backlog or voyages yet: every planned job is in "jobs".
      backlog: [],
    },
    jobs: jobs.map(j => {
      const s = jobState(j);
      const out = {
        id: j.id,
        goal: j.goal,
        files: j.files,
        done_when: byId.get(j.id).done_when.map(c => c.text),
        phase: j.phase ?? undefined,
        state: s,
      };
      if (s === 'proven' && when.has(j.id)) out.since = when.get(j.id);
      if (s === 'waiting' && j.waiting.length) out.note = `after ${j.waiting.join(', ')}`;
      out.stage = j.stage;
      out.tests = j.tests;
      if (j.by) out.by = j.by;
      if (j.where) out.where = j.where;
      if (j.after.length) out.after = j.after;
      if (j.waiting.length) out.waiting = j.waiting;
      return out;
    }),
    activity: landed.slice(0, 20).map(l => ({
      id: `landed-${l.sha.slice(0, 12)}`,
      kind: 'landed',
      title: `${l.id} landed`,
      detail: l.subject,
      at: l.at,
      evidence: [`commit/${l.sha.slice(0, 7)}`],
    })),
  };
}

// The same record in words, for a person at a terminal.
export function describe(s) {
  const row = j => `  ${j.state.padEnd(8)} ${j.id}${j.by ? ` (${j.by})` : ''}${j.note ? ` · ${j.note}` : ''}\n           ${j.goal}`;
  const groups = s.plan.phases.length
    ? s.plan.phases.map(ph => `${ph.title} · ${ph.done} of ${ph.total} proven · ${ph.state}\n  ${ph.outcome}\n${s.jobs.filter(j => j.phase === ph.id).map(row).join('\n')}`)
    : [s.jobs.map(row).join('\n')];
  const proven = s.jobs.filter(j => j.state === 'proven').length;
  return `${s.project}: ${proven} of ${s.jobs.length} jobs proven\n\n${groups.join('\n\n')}`;
}

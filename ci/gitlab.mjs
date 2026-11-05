#!/usr/bin/env node
// gmod's jobs on GitLab, run by the CI component (templates/gmod.yml):
//
//   gate    the deterministic gate on a merge request, reported as a note
//   review  the AI review, reported as a note (skipped when review is off)
//   land    a gmod/<job> merge request is set to merge once its whole
//           pipeline passes; one behind main takes main in instead, and its
//           new pipeline decides
//   after   after a landing on main (or hourly, a pipeline schedule): claims
//           let go, the tripwire, other job branches catch up, and a report
//           of what isn't landing
//
// From GitLab CI: CI_* as usual, and the project's variables GMOD_GITLAB_TOKEN
// (a person's token: a job token can't comment, merge or push) and the
// reviewer's key. From the component: GMOD_HOME, GMOD_REVIEW.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../lib/core.mjs';
import { JOB } from '../lib/gitlab.mjs';

const env = process.env;
const home = env.GMOD_HOME;
const token = env.GMOD_GITLAB_TOKEN;
const api = `${env.CI_API_V4_URL}/projects/${env.CI_PROJECT_ID}`;
const what = process.argv[2];

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'private-token': token, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { text }; }
  return { ok: res.ok, status: res.status, json };
}

const run = (script, args, extra = {}) => spawnSync('node', [join(home, script), ...args], { stdio: 'inherit', env: { ...env, ...extra } }).status ?? 1;
const git = (args, opts = {}) => core.git(args, { cwd: env.CI_PROJECT_DIR || process.cwd(), allow: true, ...opts });

if (!token) {
  console.log('gmod: no GMOD_GITLAB_TOKEN variable: gmod needs a person\'s token (api, write_repository) to comment, land and catch up. gmod setup says how.');
  process.exit(1);
}
// Pushes (claims let go, branches caught up) go as the person: a job token
// can't push, and what it could push would start no pipeline.
const pushUrl = `https://oauth2:${token}@${env.CI_SERVER_HOST}/${env.CI_PROJECT_PATH}.git`;
git(['remote', 'set-url', '--push', 'origin', pushUrl]);
git(['config', 'user.name', env.GITLAB_USER_NAME || 'gmod']);
git(['config', 'user.email', env.GITLAB_USER_EMAIL || 'gmod@localhost']);

async function note(iid, marker, file) {
  if (!existsSync(file)) return console.log(`gmod: ${file} wasn't written; no note`);
  const body = `<!-- ${marker} -->\n${readFileSync(file, 'utf8')}`;
  const list = await call('GET', `/merge_requests/${iid}/notes?per_page=100&sort=asc`);
  const mine = (list.ok ? list.json ?? [] : []).find(n => typeof n.body === 'string' && n.body.startsWith(`<!-- ${marker} -->`));
  const r = mine ? await call('PUT', `/merge_requests/${iid}/notes/${mine.id}`, { body }) : await call('POST', `/merge_requests/${iid}/notes`, { body });
  console.log(r.ok ? `gmod: ${mine ? 'updated' : 'posted'} ${marker} on !${iid}` : `gmod: couldn't post ${marker} (${r.status}): ${JSON.stringify(r.json)}`);
}

// A job branch behind main takes main in: a merge commit, pushed as the
// person, so a new pipeline runs on what it would really land on.
function catchUp(branch, main) {
  git(['fetch', '-q', 'origin', main, branch]);
  const dir = mkdtempSync(join(tmpdir(), 'gmod-catch-up-'));
  try {
    if (!git(['worktree', 'add', '-q', '--detach', dir, `origin/${branch}`]).ok) return { ok: false, why: "couldn't check it out" };
    const m = core.git(['merge', '--no-edit', '-m', `Merge ${main} into ${branch}`, `origin/${main}`], { cwd: dir, allow: true });
    if (!m.ok) return { ok: false, why: `${main} doesn't merge into it cleanly: the job needs a person or its agent` };
    const p = core.git(['push', '-q', pushUrl, `HEAD:refs/heads/${branch}`], { cwd: dir, allow: true });
    return p.ok ? { ok: true } : { ok: false, why: `the push was refused: ${p.err?.trim?.() ?? ''}` };
  } finally {
    git(['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

const iid = env.CI_MERGE_REQUEST_IID;
const main = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || env.CI_DEFAULT_BRANCH || 'main';
const common = ['--base', env.CI_MERGE_REQUEST_DIFF_BASE_SHA || `origin/${main}`, '--head', 'HEAD', '--branch', env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || '', '--title', env.CI_MERGE_REQUEST_TITLE || ''];

if (what === 'gate') {
  git(['fetch', '-q', 'origin', main]);
  const code = run('bin/gmod.mjs', ['verify', ...common, '--report', 'gate.md'], { GMOD_TOKEN: token });
  await note(iid, 'gmod-gate', 'gate.md');
  process.exit(code);
}

if (what === 'review') {
  if (env.GMOD_REVIEW === 'off') {
    console.log('gmod: no reviewer (review: off): the gate alone decides');
    process.exit(0);
  }
  git(['fetch', '-q', 'origin', main]);
  const labels = (env.CI_MERGE_REQUEST_LABELS || '').split(',');
  const code = run('ci/review.mjs', [...common, '--report', 'review.md'], {
    GMOD_REVIEW_MODE: env.GMOD_REVIEW === 'advice' ? 'comment' : '',
    GMOD_REVIEW_OVERRIDE: labels.includes('gmod-override') ? '1' : '0',
  });
  await note(iid, 'gmod-review', 'review.md');
  process.exit(code);
}

if (what === 'land') {
  const branch = env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
  const mr = await call('GET', `/merge_requests/${iid}`);
  if (!mr.ok || mr.json.state !== 'opened') process.exit(0);
  if (mr.json.draft) {
    console.log('gmod: a draft: a person marks it ready');
    process.exit(0);
  }
  if (mr.json.sha !== env.CI_COMMIT_SHA) {
    console.log('gmod: the branch moved while it was checked; its newer pipeline decides');
    process.exit(0);
  }
  git(['fetch', '-q', 'origin', main]);
  if (!git(['merge-base', '--is-ancestor', `origin/${main}`, 'HEAD']).ok) {
    // Proven against an older main: take main in, and check again.
    const c = catchUp(branch, main);
    console.log(c.ok ? `gmod: ${main} moved on; ${branch} takes it in and is checked again` : `gmod: ${branch} is behind ${main}, and ${c.why}`);
    process.exit(c.ok ? 0 : 1);
  }
  const r = await call('PUT', `/merge_requests/${iid}/merge`, { auto_merge: true, merge_when_pipeline_succeeds: true, sha: env.CI_COMMIT_SHA, should_remove_source_branch: true });
  if (!r.ok) {
    console.log(`gmod: couldn't set !${iid} to land (${r.status}): ${JSON.stringify(r.json)}`);
    process.exit(1);
  }
  console.log(`gmod: !${iid} lands once this pipeline passes`);
  process.exit(0);
}

if (what !== 'after') {
  console.log(`gmod: ci/gitlab.mjs gate|review|land|after (not ${what})`);
  process.exit(2);
}

// ---------- after: what follows a landing, and the hourly look ----------
const root = core.repoRoot(env.CI_PROJECT_DIR || process.cwd());
const sha = env.CI_COMMIT_SHA;
const scheduled = env.CI_PIPELINE_SOURCE === 'schedule';
let failed = run('bin/gmod.mjs', ['sweep']) !== 0;

const jobsOf = async pipelineId => {
  const r = await call('GET', `/pipelines/${pipelineId}/jobs?per_page=100&include_retried=false`);
  const latest = new Map();
  // Newest first: keep each job's newest state.
  for (const j of (r.ok ? r.json ?? [] : []).sort((a, b) => b.id - a.id)) if (!latest.has(j.name)) latest.set(j.name, j.status);
  return latest;
};

// Every finished job's checks, run on main as it is: the names that fail.
function checkMain(root, ref) {
  const plan = core.planAt(root, ref);
  if (!plan) return [];
  const done = core.doneJobs(root, ref);
  const names = new Set(plan.jobs.filter(j => done.has(j.id)).flatMap(j => (j.done_when ?? []).map(d => d.check)));
  const failing = [];
  for (const name of names) {
    const cmd = plan.checks?.[name];
    if (!cmd) continue;
    const r = spawnSync('sh', ['-c', cmd], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) failing.push(name);
  }
  return failing;
}

// ---- 1. the tripwire ----
const parent = core.git(['rev-parse', '--verify', '-q', `${sha}^1`], { cwd: root, allow: true }).out;
const spec = parent ? core.protectSpec(root, parent) : null;
if (scheduled) {
  // nothing just landed
} else if (!spec) {
  console.log('after-merge: no .gmod/protect.json before this landed; nothing to hold it to');
} else {
  const found = await call('GET', `/repository/commits/${sha}/merge_requests`);
  const mr = (found.ok ? found.json ?? [] : []).find(m => m.state === 'merged' && [m.merge_commit_sha, m.squash_commit_sha, m.sha].includes(sha));
  const breaches = [];
  if (!mr) {
    breaches.push(`${sha.slice(0, 10)} reached ${main} without a merge request`);
  } else {
    const ps = await call('GET', `/merge_requests/${mr.iid}/pipelines?per_page=50`);
    const pipeline = (ps.ok ? ps.json ?? [] : []).filter(p => p.sha === mr.sha).sort((a, b) => b.id - a.id)[0];
    const jobs = pipeline ? await jobsOf(pipeline.id) : new Map();
    for (const need of spec.require) {
      const state = jobs.get(JOB[need]) ?? 'missing';
      if (state !== 'success') breaches.push(`!${mr.iid} merged with its ${need} ${state === 'missing' ? 'never run' : state}`);
    }
    // Up to date? GitLab can run two auto-merges at the same moment, and
    // then semi-linear history doesn't stop the second: it lands on a main
    // its pipeline never saw. Then main itself is checked, as merged: every
    // finished job's checks.
    git(['fetch', '-q', 'origin', `+refs/merge-requests/${mr.iid}/head:refs/gmod/landed`]);
    const before = core.git(['rev-parse', '--verify', '-q', `${sha}^1`], { cwd: root, allow: true }).out;
    if (spec.up_to_date && before && mr.sha !== sha && !git(['merge-base', '--is-ancestor', before, mr.sha]).ok) {
      const failing = checkMain(root, sha);
      if (failing.length) breaches.push(`!${mr.iid} landed on a main its pipeline never saw, and main now fails: ${failing.join(', ')}`);
      else console.log(`after-merge: !${mr.iid} landed on a main its pipeline never saw (GitLab merged two at once); main as merged passes every finished job's checks`);
    }
  }
  if (breaches.length) {
    failed = true;
    const title = `gmod breach: ${breaches[0]}${breaches.length > 1 ? ` (and ${breaches.length - 1} more)` : ''}`;
    const description = [
      `Something landed on ${main} without passing what .gmod/protect.json requires (${spec.require.join(' and ')}).`,
      '',
      ...breaches.map(b => `- ${b}`),
      '',
      `Commit: ${sha}. Check ${main}'s protection and merge settings (\`gmod ci protect\` puts them back), and look at what landed.`,
    ].join('\n');
    const r = await call('POST', '/issues', { title, description });
    console.log(r.ok ? `after-merge: ${title} (issue #${r.json.iid})` : `after-merge: ${title}; couldn't open an issue (${r.status})`);
  } else {
    console.log(`after-merge: what landed passed ${spec.require.join(' and ')}`);
  }
}

// ---- 2. bring the open jobs up to date ----
const open = await call('GET', '/merge_requests?state=opened&per_page=100');
const jobMrs = (open.ok ? open.json ?? [] : []).filter(m => (m.source_branch ?? '').startsWith('gmod/') && m.source_project_id === m.target_project_id && m.target_branch === main);
git(['fetch', '-q', 'origin', main]);
for (const mr of jobMrs) {
  git(['fetch', '-q', 'origin', mr.source_branch]);
  if (git(['merge-base', '--is-ancestor', `origin/${main}`, mr.sha]).ok) continue;
  const c = catchUp(mr.source_branch, main);
  console.log(c.ok ? `after-merge: !${mr.iid} (${mr.source_branch}) takes ${main} in; its pipeline runs again` : `after-merge: !${mr.iid} (${mr.source_branch}) couldn't take ${main} in: ${c.why}`);
}

// ---- 3. what isn't landing ----
const STUCK_HOURS = Number(env.GMOD_STUCK_HOURS || 2);
const CLAIM_HOURS = Number(env.GMOD_CLAIM_HOURS || 24);
const hoursSince = iso => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : NaN);
const ago = h => (h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)} days`);
const required = (core.protectSpec(root, sha) ?? { require: ['gate'] }).require;
const stuck = new Map();
const moving = new Set();
for (const m of jobMrs) {
  const job = m.source_branch.slice('gmod/'.length);
  moving.add(job);
  const full = await call('GET', `/merge_requests/${m.iid}`);
  const hp = full.ok ? full.json.head_pipeline : null;
  const quiet = Math.min(...[m.updated_at, hp?.updated_at].map(hoursSince).filter(h => h >= 0));
  if (!(quiet >= STUCK_HOURS && quiet !== Infinity)) continue;
  const jobs = hp ? await jobsOf(hp.id) : new Map();
  const state = need => jobs.get(JOB[need]) ?? 'missing';
  const failedNeed = required.find(n => ['failed', 'canceled'].includes(state(n)));
  if (failedNeed) stuck.set(job, `!${m.iid}'s ${failedNeed} failed, and nothing has changed in ${ago(quiet)}. Its note says why: the job needs fixing (or, for a review that couldn't answer, running again).`);
  else if (required.some(n => state(n) !== 'success')) stuck.set(job, `!${m.iid}'s pipeline hasn't finished in ${ago(quiet)} (${required.map(n => `${n} ${state(n)}`).join(', ')}). Is a runner picking it up?`);
  else stuck.set(job, `!${m.iid} passed ${ago(quiet)} ago but hasn't merged (pipeline ${hp?.status ?? 'missing'}). Did gmod-land run, and did the whole pipeline pass?`);
}
core.syncClaims(root);
for (const [job, c] of Object.entries(core.claims(root))) {
  if (moving.has(job)) continue;
  moving.add(job);
  const h = hoursSince(c.at);
  if (h >= CLAIM_HOURS) stuck.set(job, `claimed by ${c.by ?? 'someone'} ${ago(h)} ago, and no merge request yet. Finish it, or \`gmod release\` it so another agent can.`);
}
const issues = await call('GET', `/issues?state=opened&in=title&search=${encodeURIComponent('gmod stuck')}&per_page=100`);
const filed = new Map((issues.ok ? issues.json ?? [] : []).filter(i => i.title?.startsWith('gmod stuck: ')).map(i => [i.title.slice('gmod stuck: '.length), i.iid]));
for (const [job, why] of stuck) {
  if (filed.has(job)) {
    console.log(`after-merge: ${job} is still stuck (#${filed.get(job)})`);
    continue;
  }
  const r = await call('POST', '/issues', { title: `gmod stuck: ${job}`, description: `${why}\n\nOpened by gmod's look at what isn't landing (after each merge, and hourly); it closes once the job lands or is let go.` });
  console.log(r.ok ? `after-merge: gmod stuck: ${job} (issue #${r.json.iid}): ${why}` : `after-merge: ${job} is stuck, and the issue couldn't be opened (${r.status}): ${why}`);
}
for (const [job, number] of filed) {
  if (stuck.has(job) || moving.has(job)) continue;
  await call('POST', `/issues/${number}/notes`, { body: `${job} has landed or been let go.` });
  const r = await call('PUT', `/issues/${number}`, { state_event: 'close' });
  console.log(r.ok ? `after-merge: ${job} isn't stuck any more; closed #${number}` : `after-merge: couldn't close #${number} (${r.status})`);
}
process.exit(failed ? 1 : 0);

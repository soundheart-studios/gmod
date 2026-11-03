#!/usr/bin/env node
// After something lands on main, in CI (the push to main):
//
// 1. A tripwire. Did what landed pass what main requires (.gmod/protect.json
//    on main before it)? A pull request merged without its gate or review
//    passing, or a push straight to main, opens an issue titled
//    "gmod breach: …". Protection can be changed by anyone holding an admin's
//    token; this notices when that let something through.
// 2. Every other open job branch (gmod/<job>) that is now behind main takes
//    main in (the forge's "update branch"), so its checks run again on what
//    it would really land on, and auto-merge lands it once they pass.
// 3. What isn't landing. A job whose pull request failed and nothing has
//    changed since, whose checks never finished, that passed but didn't
//    merge, or that was claimed long ago with no pull request: one issue
//    each, titled "gmod stuck: <job>", closed again once it is gone. Also
//    run hourly (the workflow's schedule), where step 1 is skipped.
//
// From the CI environment: GITHUB_SERVER_URL (or GITEA_URL), GITHUB_REPOSITORY,
// GMOD_TOKEN, GMOD_SHA (the commit that landed), and GMOD_FORGE_TOKEN: the
// forge starts no checks for what CI's own token pushes, so the update is
// made with a person's token when the repository keeps one. Gitea only.
import * as core from '../lib/core.mjs';

const server = (process.env.GITEA_URL || process.env.GITHUB_SERVER_URL || '').replace(/\/$/, '');
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GMOD_TOKEN;
const sha = process.env.GMOD_SHA;
if (!server || !repo || !token || !sha) {
  console.log('after-merge: not in CI on a push with a token; skipped');
  process.exit(0);
}
if (process.env.GITHUB_API_URL?.includes('api.github.com')) {
  console.log('after-merge: GitHub is not handled yet; skipped');
  process.exit(0);
}
const api = `${server}/api/v1/repos/${repo}`;
const headers = { authorization: `token ${token}`, 'content-type': 'application/json', accept: 'application/json' };
const updater = process.env.GMOD_FORGE_TOKEN || '';
async function call(method, path, body, as = token) {
  const res = await fetch(`${api}${path}`, { method, headers: { ...headers, authorization: `token ${as}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { text };
  }
  return { ok: res.ok, status: res.status, json };
}

const root = core.repoRoot();
const plan = core.planFromDisk(root);
const main = plan?.main ?? 'main';
let failed = false;

const scheduled = process.env.GITHUB_EVENT_NAME === 'schedule';

// ---- 1. the tripwire ----
const parent = core.git(['rev-parse', '--verify', '-q', `${sha}^1`], { cwd: root, allow: true }).out;
const spec = parent ? core.protectSpec(root, parent) : null;
if (scheduled) {
  // The hourly look: nothing just landed.
} else if (!spec) {
  console.log('after-merge: no .gmod/protect.json before this landed; nothing to hold it to');
} else {
  const closed = await call('GET', '/pulls?state=closed&sort=recentupdate&limit=50');
  const pr = (closed.ok ? closed.json ?? [] : []).find(p => p.merged && p.merge_commit_sha === sha);
  const breaches = [];
  if (!pr) {
    breaches.push(`${sha.slice(0, 10)} reached ${main} without a pull request`);
  } else {
    const st = await call('GET', `/commits/${pr.head.sha}/status`);
    const latest = new Map();
    // Newest first from the API: keep each context's newest state.
    for (const x of st.ok ? st.json?.statuses ?? [] : []) if (!latest.has(x.context)) latest.set(x.context, x.status);
    for (const need of spec.require) {
      const state = latest.get(`gmod / ${need} (pull_request)`) ?? 'missing';
      if (state !== 'success') breaches.push(`#${pr.number} merged with its ${need} ${state === 'missing' ? 'never reported' : state}`);
    }
  }
  if (breaches.length) {
    failed = true;
    const title = `gmod breach: ${breaches[0]}${breaches.length > 1 ? ` (and ${breaches.length - 1} more)` : ''}`;
    const body = [
      `Something landed on ${main} without passing what .gmod/protect.json requires (${spec.require.join(' and ')}).`,
      '',
      ...breaches.map(b => `- ${b}`),
      '',
      `Commit: ${sha}. Check ${main}'s branch protection (\`gmod ci protect\` puts it back), and look at what landed.`,
    ].join('\n');
    const r = await call('POST', '/issues', { title, body });
    console.log(r.ok ? `after-merge: ${title} (issue #${r.json.number})` : `after-merge: ${title}; couldn't open an issue (${r.status})`);
  } else {
    console.log(`after-merge: what landed passed ${spec.require.join(' and ')}`);
  }
}

// ---- 2. bring the open jobs up to date ----
const open = await call('GET', '/pulls?state=open&limit=50');
const jobPrs = (open.ok ? open.json ?? [] : []).filter(pr => (pr.head?.ref ?? '').startsWith('gmod/') && pr.head?.repo?.full_name === repo);
for (const pr of jobPrs) {
  const ref = pr.head.ref;
  const behind = !core.git(['merge-base', '--is-ancestor', sha, pr.head.sha], { cwd: root, allow: true }).ok;
  if (!behind) continue;
  const r = await call('POST', `/pulls/${pr.number}/update?style=merge`, null, updater || token);
  console.log(r.ok ? `after-merge: #${pr.number} (${ref}) takes ${main} in${updater ? '' : " (with CI's own token: its checks won't start again until it gets a new commit; set the GMOD_FORGE_TOKEN secret)"}` : `after-merge: #${pr.number} (${ref}) couldn't take ${main} in (${r.status}): ${JSON.stringify(r.json)}`);
}
// ---- 3. what isn't landing ----
const STUCK_HOURS = Number(process.env.GMOD_STUCK_HOURS || 2);
const CLAIM_HOURS = Number(process.env.GMOD_CLAIM_HOURS || 24);
const hoursSince = iso => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : NaN);
const ago = h => (h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)} days`);
const required = (core.protectSpec(root, sha) ?? { require: ['gate'] }).require;
const stuck = new Map();
const moving = new Set();
for (const pr of jobPrs) {
  const job = pr.head.ref.slice('gmod/'.length);
  moving.add(job);
  const st = await call('GET', `/commits/${pr.head.sha}/status`);
  const statuses = st.ok ? st.json?.statuses ?? [] : [];
  const latest = new Map();
  for (const x of statuses) if (!latest.has(x.context)) latest.set(x.context, x.status);
  // Quiet since the last thing that happened to it: a push, an update, a check.
  const quiet = Math.min(...[pr.updated_at, ...statuses.map(x => x.updated_at)].map(hoursSince).filter(h => h >= 0));
  if (!(quiet >= STUCK_HOURS && quiet !== Infinity)) continue;
  const state = need => latest.get(`gmod / ${need} (pull_request)`) ?? 'missing';
  const failedNeed = required.find(n => ['failure', 'error'].includes(state(n)));
  if (failedNeed) stuck.set(job, `#${pr.number}'s ${failedNeed} failed, and nothing has changed in ${ago(quiet)}. Its report says why: the job needs fixing (or, for a review that couldn't answer, running again).`);
  else if (required.some(n => state(n) !== 'success')) stuck.set(job, `#${pr.number}'s checks haven't finished in ${ago(quiet)} (${required.map(n => `${n} ${state(n)}`).join(', ')}). Is the runner up?`);
  else stuck.set(job, `#${pr.number} passed everything ${ago(quiet)} ago but hasn't merged. Is it set to land on green (\`gmod pr --auto\`)?`);
}
// Claims on jobs done on main were let go by the step before this one.
core.syncClaims(root);
for (const [job, c] of Object.entries(core.claims(root))) {
  if (moving.has(job)) continue;
  moving.add(job);
  const h = hoursSince(c.at);
  if (h >= CLAIM_HOURS) stuck.set(job, `claimed by ${c.by ?? 'someone'} ${ago(h)} ago, and no pull request yet. Finish it, or \`gmod release\` it so another agent can.`);
}
const issues = await call('GET', '/issues?state=open&type=issues&limit=50');
const filed = new Map((issues.ok ? issues.json ?? [] : []).filter(i => i.title?.startsWith('gmod stuck: ')).map(i => [i.title.slice('gmod stuck: '.length), i.number]));
for (const [job, why] of stuck) {
  if (filed.has(job)) {
    console.log(`after-merge: ${job} is still stuck (#${filed.get(job)})`);
    continue;
  }
  const r = await call('POST', '/issues', { title: `gmod stuck: ${job}`, body: `${why}\n\nOpened by gmod's look at what isn't landing (after each merge, and hourly); it closes once the job lands or is let go.` });
  console.log(r.ok ? `after-merge: gmod stuck: ${job} (issue #${r.json.number}): ${why}` : `after-merge: ${job} is stuck, and the issue couldn't be opened (${r.status}): ${why}`);
}
for (const [job, number] of filed) {
  if (stuck.has(job) || moving.has(job)) continue;
  await call('POST', `/issues/${number}/comments`, { body: `${job} has landed or been let go.` });
  const r = await call('PATCH', `/issues/${number}`, { state: 'closed' });
  console.log(r.ok ? `after-merge: ${job} isn't stuck any more; closed #${number}` : `after-merge: couldn't close #${number} (${r.status})`);
}
process.exit(failed ? 1 : 0);

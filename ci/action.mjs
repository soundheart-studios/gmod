#!/usr/bin/env node
// The gmod action on GitHub and Gitea: one step that does what the event
// calls for.
//
//   pull_request         the gate, then the AI review, each reported as a
//                        check ("gmod / gate", "gmod / review") and a
//                        comment; then, if both passed on a gmod branch, it
//                        lands: merged by gmod, since many plans (free
//                        private repositories) have no auto-merge.
//   push, schedule       after something lands (or hourly): claims on done
//                        jobs are let go, the tripwire, other job branches
//                        catch up, and a report of what isn't landing.
//   repository_dispatch  "gmod" events gmod sends itself. What CI's own token
//                        merges or pushes starts no run, except this event:
//                          {landed: <sha>}  after-merge for what gmod merged
//                          {check: <pr>}    gate, review and land a pull
//                                           request that caught up with main
//                          {work: true}     an agent takes the next ready job
//
// Agents in CI (with an agent key): after each landing, and hourly, one
// agent is started per ready job (on Gitea, in the same run), at most GMOD_AGENTS at once (counted
// by the claims agents hold). Each runs Claude Code headless with gmod
// loaded, does one job the way an agent at a keyboard does (claim, red,
// green, mcp__gmod__commit), and stops if anything is refused. A job whose
// agent couldn't finish gets a "gmod stuck" issue, and isn't handed to an
// agent again while that issue is open.
//
// On Gitea (its Actions run the same action) checks are reported under the
// names Gitea's protection already requires ("gmod / gate (pull_request)"),
// Gitea itself merges once they pass (auto-merge, set as the pull request
// opens), and what a person's token pushes starts runs, so no dispatch: a
// branch behind main is brought up to date with GMOD_FORGE_TOKEN.
//
// From the action: GMOD_HOME (gmod itself), GMOD_GITHUB_TOKEN, and the
// reviewer's settings. From the forge: GITHUB_* as usual.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../lib/core.mjs';
import * as agents from '../lib/agent.mjs';

const home = process.env.GMOD_HOME;
let token = process.env.GMOD_GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
// Gitea's Actions set GITHUB_API_URL too, under /api/v1.
const gitea = process.env.GMOD_FORGE ? process.env.GMOD_FORGE === 'gitea' : /\/api\/v1$/.test(api);
let forgeToken = process.env.GMOD_FORGE_TOKEN || '';
// With a GitHub App (app-id, app-key): everything as the App. What it opens,
// updates and merges starts runs by itself, so no dispatch is needed for
// those, and git pushes as the App too.
let viaApp = false;
if (!gitea && process.env.GMOD_APP_ID && process.env.GMOD_APP_KEY) {
  const { appToken } = await import('../lib/app.mjs');
  try {
    token = await appToken({ appId: process.env.GMOD_APP_ID, key: process.env.GMOD_APP_KEY, repo, api });
    forgeToken = token;
    viaApp = true;
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    spawnSync('git', ['config', '--local', 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`]);
    console.log('gmod: working as the gmod App');
  } catch (e) {
    console.log(`gmod: ${e.message}; working with CI's own token instead`);
  }
}
const CONTEXT = { gate: gitea ? 'gmod / gate (pull_request)' : 'gmod / gate', review: gitea ? 'gmod / review (pull_request)' : 'gmod / review' };
const event = process.env.GITHUB_EVENT_NAME;
const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const reviewer = !!(process.env.GMOD_REVIEW_URL || process.env.ANTHROPIC_API_KEY);
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

// gmod checked out inside the repository (Gitea's .gmod-tool) is never part
// of anyone's work: git doesn't see it, so no commit can take it in.
{
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout?.trim();
  const rel = top && home ? join(home).replace(/\/$/, '') : '';
  if (top && rel.startsWith(top + '/')) {
    const exclude = join(top, '.git', 'info', 'exclude');
    const line = `/${rel.slice(top.length + 1)}/`;
    let have = '';
    try { have = readFileSync(exclude, 'utf8'); } catch {}
    if (!have.split('\n').includes(line)) appendFileSync(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
}
// An agent key: a Claude Code sign-in token (sk-ant-oat…) or an API key.
const agentKey = process.env.GMOD_AGENT_KEY || '';
const AGENTS = Math.max(0, Number(process.env.GMOD_AGENTS || 1));

async function gh(method, path, body, as = token) {
  const send = () => fetch(`${api}/repos/${repo}${path}`, {
    method,
    headers: gitea
      ? { authorization: `token ${as}`, accept: 'application/json', 'content-type': 'application/json' }
      : { authorization: `Bearer ${as}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // A dropped connection ("other side closed") is tried again, twice, before
  // it fails the run; an answer from the forge, even an error, is final.
  let res;
  for (let i = 0; ; i++) {
    try { res = await send(); break; } catch (e) {
      if (i >= 2) throw e;
      console.log(`gmod: ${method} ${path} dropped (${e.cause?.code ?? e.message}); trying again`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { text }; }
  return { ok: res.ok, status: res.status, json };
}

function run(script, args, env = {}) {
  const r = spawnSync('node', [join(home, script), ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
  return r.status ?? 1;
}

function git(...args) {
  return spawnSync('git', args, { stdio: 'inherit' }).status === 0;
}

async function status(sha, context, state, description) {
  const r = await gh('POST', `/statuses/${sha}`, { state, context, description: description.slice(0, 140), target_url: runUrl });
  if (!r.ok) console.log(`gmod: couldn't report ${context} (${r.status}): ${JSON.stringify(r.json)}`);
}

function comment(pr, marker, file) {
  run('ci/comment.mjs', ['--marker', marker, '--file', file], { GMOD_PR: String(pr), GMOD_TOKEN: token });
}

async function dispatch(clientPayload) {
  const r = await gh('POST', '/dispatches', { event_type: 'gmod', client_payload: clientPayload });
  if (!r.ok) console.log(`gmod: couldn't start the follow-up run ${JSON.stringify(clientPayload)} (${r.status})`);
  return r.ok;
}

// What follows a landing: claims, the tripwire, catch-up, what's stuck.
async function afterMerge(sha) {
  const env = { GMOD_TOKEN: token, GMOD_SHA: sha, GMOD_FORGE: gitea ? 'gitea' : 'github', ...(viaApp ? { GMOD_FORGE_TOKEN: token } : {}) };
  const swept = run('bin/gmod.mjs', ['sweep']);
  const after = run('ci/after-merge.mjs', [], env);
  await startAgents();
  return swept || after;
}

// Agents for the jobs a landing made ready, up to GMOD_AGENTS at once. On
// GitHub each is a run of its own (repository_dispatch); Gitea has no such
// event, so there the agent works in this run, one job per run.
async function startAgents() {
  if (!agentKey || !AGENTS) return;
  const root = core.repoRoot();
  git('fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  const plan = core.planAt(root, 'origin/HEAD') ?? core.planFromDisk(root);
  if (!plan) return;
  core.syncClaims(root);
  const open = await gh('GET', gitea ? '/pulls?state=open&limit=50' : '/pulls?state=open&per_page=100');
  for (const id of agents.staleAgentClaims(root, new Set((open.ok ? open.json ?? [] : []).map(p => p.head?.ref)))) {
    run('bin/gmod.mjs', ['release', id]);
    console.log(`gmod: let go of an agent's claim on ${id}: no pull request open for it`);
  }
  const ready = agents.readyJobs(root, plan, await stuckJobs());
  const held = agents.agentClaims(root).length;
  const n = Math.max(0, Math.min(ready.length, AGENTS - held));
  if (ready.length || held) console.log(`gmod: ${ready.length} job(s) ready, ${held} with agents; ${n} agent(s) started`);
  if (!n) return;
  if (gitea) {
    await work();
    return;
  }
  for (let i = 0; i < n; i++) await dispatch({ work: true });
}

async function stuckJobs() {
  const issues = await gh('GET', gitea ? '/issues?state=open&type=issues&limit=50' : '/issues?state=open&per_page=100');
  return new Set((issues.ok ? issues.json ?? [] : []).filter(i => !i.pull_request && i.title?.startsWith('gmod stuck: ')).map(i => i.title.slice(12)));
}

// What gmod's own commands need to open pull requests as the agent: gh's
// token on GitHub (CI's own), the person's token on Gitea (a pull request
// opened with Gitea's Actions token starts no run).
const prEnv = () => (gitea ? { GITEA_TOKEN: forgeToken || token } : { GH_TOKEN: token });

// A ready job whose branch already holds its commit, with no pull request
// (its agent was refused at the last step): open it, without a model. CI
// proves it all again anyway.
async function openFinished(root) {
  git('fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  const plan = core.planFromDisk(root);
  if (!plan) return false;
  // Any pull request at all, open or closed: a closed one was a person's no,
  // and its work isn't reopened behind their back.
  const all = await gh('GET', gitea ? '/pulls?state=all&limit=50' : '/pulls?state=all&per_page=100');
  const opened = new Set((all.ok ? all.json ?? [] : []).map(p => p.head?.ref));
  for (const j of agents.readyJobs(root, plan)) {
    const branch = `gmod/${j.id}`;
    if (opened.has(branch)) continue;
    const subjects = core.git(['log', '--format=%s', `origin/${plan.main ?? 'main'}..origin/${branch}`], { cwd: root, allow: true });
    if (!subjects.ok || !subjects.out.split('\n').some(x => x.startsWith(`${j.id}:`))) continue;
    if (run('bin/gmod.mjs', ['claim', j.id, '--resume']) !== 0) continue;
    const pr = spawnSync('node', [join(home, 'bin/gmod.mjs'), 'pr', '--auto', '--json'], { encoding: 'utf8', env: { ...process.env, ...prEnv() } });
    const url = (pr.stdout || '').match(/"url":\s*"([^"]+)"/)?.[1];
    const number = Number(url?.match(/(\d+)$/)?.[1]);
    if (!number) {
      console.log(`gmod: ${j.id} is finished on ${branch}, and its pull request still can't be opened: ${(pr.stderr || pr.stdout || '').trim()}`);
      run('bin/gmod.mjs', ['release', j.id]);
      return true;
    }
    console.log(`gmod: ${j.id} was finished on ${branch}; opened #${number}${gitea ? '' : ', now checked'}`);
    if (!gitea && !viaApp) await dispatch({ check: number });
    return true;
  }
  return false;
}

// One agent, one job.
async function work() {
  if (!agentKey) {
    console.log('gmod: no agent key: no agents in CI');
    return 0;
  }
  const root = core.repoRoot();
  git('config', 'user.name', agents.AGENT.name);
  git('config', 'user.email', agents.AGENT.email);
  if (await openFinished(root)) return 0;
  const r = agents.runAgent({ root, home, key: agentKey, version: process.env.GMOD_CLAUDE_VERSION || 'latest', turns: process.env.GMOD_AGENT_TURNS || '60', env: { ...prEnv(), GMOD_TOKEN: forgeToken || token } });
  const open = await gh('GET', gitea ? '/pulls?state=open&limit=50' : '/pulls?state=open&per_page=100');
  let started = 0;
  for (const job of r.claimed) {
    const pr = (open.ok ? open.json ?? [] : []).find(p => p.head?.ref === `gmod/${job}`);
    if (pr) {
      // On GitHub it was opened with CI's own token, which starts no run.
      if (!gitea && !viaApp) await dispatch({ check: pr.number });
      started++;
      console.log(`gmod: the agent finished ${job}: #${pr.number}`);
      continue;
    }
    // Couldn't finish: let the job go, and say why where a person sees it.
    run('bin/gmod.mjs', ['release', job]);
    await gh('POST', '/issues', { title: `gmod stuck: ${job}`, body: agents.stuckBody(job, r.said, runUrl) });
    console.log(`gmod: the agent couldn't finish ${job}; released, and reported stuck`);
  }
  if (!r.claimed.length) console.log('gmod: the agent took no job');
  return r.ok || started ? 0 : 1;
}

// ---------- agents fix their own pull requests ----------

// Is this pull request an agent's? Its job is held by the agent.
function agentsJob(pr) {
  const id = pr.head?.ref?.match(/^gmod\/(.+)$/)?.[1];
  if (!id) return null;
  const root = core.repoRoot();
  core.syncClaims(root);
  return core.claims(root)[id]?.by === agents.AGENT.email ? id : null;
}

// A failed check on an agent's own pull request: an agent fixes it (on
// GitHub in a run of its own, on Gitea in this one). The run still fails:
// what was checked failed.
async function failed(pr) {
  if (agentKey && AGENTS && agentsJob(pr)) {
    if (gitea) await fix(pr.number);
    else await dispatch({ fix: pr.number });
  }
  return 1;
}

const commentsOf = async number => {
  const r = await gh('GET', gitea ? `/issues/${number}/comments?limit=50` : `/issues/${number}/comments?per_page=100`);
  return r.ok ? r.json ?? [] : [];
};

// An agent picks its job back up, with the checks' reports (or a
// maintainer's request) as its brief. At most FIX_TRIES tries for failed
// checks; then the job is reported stuck for a person.
async function fix(number, request) {
  if (!agentKey) return 0;
  const pr = (await gh('GET', `/pulls/${number}`)).json;
  if (!pr || pr.state !== 'open') return 0;
  const job = agentsJob(pr);
  if (!job) {
    console.log(`gmod: #${number} isn't an agent's job; a person fixes it`);
    return 0;
  }
  const comments = await commentsOf(number);
  const tries = comments.filter(c => (c.body ?? '').startsWith(agents.FIX_MARKER)).length;
  // Commits on the branch by someone other than the agent: no new commit can
  // take them out, and the gate never lets them through. A person decides.
  const gate = comments.filter(c => (c.body ?? '').startsWith('<!-- gmod-gate -->')).at(-1)?.body ?? '';
  const foreign = gate.match(/❌ claimed by [^\n]*, but its commits are by [^\n]*/)?.[0];
  if (!request && foreign) {
    const stuck = await stuckJobs();
    if (!stuck.has(job)) await gh('POST', '/issues', { title: `gmod stuck: ${job}`, body: `#${number} carries commits not made by the agent that holds ${job} (${foreign.replace(/^❌ /, '')}). The gate refuses that, and no agent can take the commits out. Close #${number} and delete its branch to have an agent start ${job} over, or take the job yourself.\n\nNo agent takes ${job} again while this issue is open.` });
    console.log(`gmod: #${number} has commits by someone else; reported stuck without a fix`);
    return 0;
  }
  if (!request && tries >= agents.FIX_TRIES) {
    const stuck = await stuckJobs();
    if (!stuck.has(job)) await gh('POST', '/issues', { title: `gmod stuck: ${job}`, body: `Agents tried ${tries} times to make #${number} pass its checks, and it still doesn't. It needs a person: read its gate and review comments.\n\nNo agent takes ${job} again while this issue is open.` });
    console.log(`gmod: #${number} failed after ${tries} fixes; reported stuck`);
    return 0;
  }
  await gh('POST', `/issues/${number}/comments`, { body: `${agents.FIX_MARKER}\ngmod: an agent is ${request ? 'working on the request above' : `fixing what failed (try ${tries + 1} of ${agents.FIX_TRIES})`}.` });
  const reports = comments.filter(c => /^<!-- gmod-(gate|review) -->/.test(c.body ?? '')).map(c => c.body.replace(/^<!-- [^>]+ -->\n/, ''));
  const root = core.repoRoot();
  const r = agents.runAgent({
    root, home, key: agentKey, version: process.env.GMOD_CLAUDE_VERSION || 'latest', turns: process.env.GMOD_AGENT_TURNS || '60',
    env: { ...prEnv(), GMOD_TOKEN: forgeToken || token },
    prompt: agents.fixPrompt({ job, number, reports, request }),
  });
  const now = (await gh('GET', `/pulls/${number}`)).json;
  if (now?.head?.sha && now.head.sha !== pr.head.sha) {
    console.log(`gmod: the agent pushed a fix to #${number}`);
    if (!gitea && !viaApp) await dispatch({ check: number });
    return 0;
  }
  console.log(`gmod: the agent didn't change #${number}: ${r.said.split('\n').slice(-2).join(' ')}`);
  await gh('POST', `/issues/${number}/comments`, { body: `gmod: the agent couldn't ${request ? 'do that' : 'fix it'}:\n\n> ${r.said.split('\n').slice(-6).join('\n> ') || '(it said nothing)'}` });
  return 0;
}

// "@gmod …" from someone who can write to the repository, on an agent's
// pull request: an agent does what it says.
async function mention() {
  const body = payload.comment?.body ?? '';
  const issue = payload.issue;
  if (!/(^|\s)@gmod\b/.test(body) || !issue?.pull_request) return 0;
  const who = payload.comment?.user?.login ?? payload.sender?.login;
  if (/\[bot\]$/.test(who ?? '') || body.startsWith(agents.FIX_MARKER)) return 0;
  const perm = await gh('GET', `/collaborators/${encodeURIComponent(who)}/permission`);
  const level = perm.json?.permission ?? perm.json?.role_name;
  if (!['admin', 'maintain', 'write', 'owner'].includes(level)) {
    console.log(`gmod: ${who} can't ask agents for work here (${level ?? 'no access'})`);
    return 0;
  }
  return fix(issue.number, body.replace(/(^|\s)@gmod\b/, '$1').trim());
}

// Gate, review, and land one pull request, as checked out at its head.
async function checkAndLand(pr) {
  if (pr.head.repo?.full_name !== repo) {
    console.log('gmod: a pull request from a fork gets no secrets; nothing to check with');
    return 0;
  }
  if (pr.state !== 'open') return 0;
  const sha = pr.head.sha;
  const common = ['--base', pr.base.sha, '--head', 'HEAD', '--branch', pr.head.ref, '--title', pr.title];

  await status(sha, CONTEXT.gate, 'pending', 'proving the change');
  // Reading main's rules needs only read access: CI's own token does.
  const gate = run('bin/gmod.mjs', ['verify', ...common, '--report', 'gate.md'], { GMOD_TOKEN: process.env.GMOD_FORGE_TOKEN || token });
  await status(sha, CONTEXT.gate, gate === 0 ? 'success' : 'failure', gate === 0 ? 'proven' : 'not proven: see the gate comment');
  comment(pr.number, 'gmod-gate', 'gate.md');
  if (gate !== 0) return failed(pr);

  if (reviewer) {
    await status(sha, CONTEXT.review, 'pending', 'the AI is reading it');
    const labels = (pr.labels ?? []).map(l => l.name);
    const review = run('ci/review.mjs', [...common, '--report', 'review.md'], { GMOD_REVIEW_OVERRIDE: labels.includes('gmod-override') ? '1' : '0' });
    await status(sha, CONTEXT.review, review === 0 ? 'success' : 'failure', review === 0 ? 'passed' : 'failed: see the review comment');
    comment(pr.number, 'gmod-review', 'review.md');
    if (review !== 0) return failed(pr);
  }

  // Land it: gmod's own branches only, and only what was just checked.
  if (!pr.head.ref.startsWith('gmod/') || pr.draft) {
    console.log('gmod: passed; not a gmod branch (or a draft), so a person merges it');
    return 0;
  }

  const now = await gh('GET', `/pulls/${pr.number}`);
  if (!now.ok || now.json.state !== 'open') return 0;
  if (now.json.head.sha !== sha) {
    console.log('gmod: the branch moved while it was checked; the next run decides');
    return 0;
  }
  // A person holding it (to ask for a change with @gmod, say): checked, not
  // landed. Read now, not from the event: a label put on while the checks
  // ran counts.
  if ((now.json.labels ?? []).some(l => l.name === 'gmod-hold')) {
    console.log('gmod: passed; held with the gmod-hold label, so it lands once that comes off');
    return 0;
  }
  if (gitea) return landOnGitea(pr, sha);
  const compare = await gh('GET', `/compare/${encodeURIComponent(pr.base.ref)}...${sha}`);
  if (compare.ok && compare.json.behind_by > 0) {
    // Behind main: proven against old code. Take main in, then check again.
    const up = await gh('PUT', `/pulls/${pr.number}/update-branch`, { expected_head_sha: sha });
    if (!up.ok) {
      console.log(`gmod: behind ${pr.base.ref}, and couldn't take it in (${up.status}): ${JSON.stringify(up.json)}`);
      return 1;
    }
    console.log(`gmod: ${pr.base.ref} moved on; #${pr.number} takes it in and is checked again`);
    if (!viaApp) await dispatch({ check: pr.number });
    return 0;
  }
  const merged = await gh('PUT', `/pulls/${pr.number}/merge`, { merge_method: 'merge', sha });
  if (!merged.ok) {
    // main moved between the look above and the merge (another pull request
    // landed): the forge's rules refuse it, rightly. Catch up and check again
    // rather than fail what passed.
    const after = await gh('GET', `/compare/${encodeURIComponent(pr.base.ref)}...${sha}`);
    if (merged.status === 405 && after.ok && after.json.behind_by > 0) {
      const up = await gh('PUT', `/pulls/${pr.number}/update-branch`, { expected_head_sha: sha });
      console.log(`gmod: ${pr.base.ref} moved on just as #${pr.number} was landing; it takes ${pr.base.ref} in and is checked again${up.ok ? '' : ` (couldn't take it in: ${up.status})`}`);
      if (up.ok && !viaApp) await dispatch({ check: pr.number });
      return up.ok ? 0 : 1;
    }
    console.log(`gmod: couldn't land #${pr.number} (${merged.status}): ${JSON.stringify(merged.json)}`);
    return 1;
  }
  console.log(`gmod: landed #${pr.number} on ${pr.base.ref}`);
  // What CI's own token merges starts no push run: start what follows a landing.
  if (!viaApp) await dispatch({ landed: merged.json.sha });
  return 0;
}

// Gitea: behind main, take main in as the person (that push starts the next
// run); otherwise Gitea merges it once the checks just reported pass.
async function landOnGitea(pr, sha) {
  const base = pr.base.ref;
  const behind = !git('fetch', '-q', 'origin', base) || spawnSync('git', ['merge-base', '--is-ancestor', `origin/${base}`, sha]).status !== 0;
  const as = forgeToken || token;
  if (behind) {
    const up = await gh('POST', `/pulls/${pr.number}/update?style=merge`, null, as);
    console.log(up.ok ? `gmod: ${base} moved on; #${pr.number} takes it in and is checked again${forgeToken ? '' : ' (with CI\'s own token no new run starts: set GMOD_FORGE_TOKEN)'}` : `gmod: behind ${base}, and couldn't take it in (${up.status}): ${JSON.stringify(up.json)}`);
    return up.ok ? 0 : 1;
  }
  const m = await gh('POST', `/pulls/${pr.number}/merge`, { Do: 'merge', merge_when_checks_succeed: true, head_commit_id: sha }, as);
  // Already set to merge, or merged just now: both are fine.
  if (m.ok || m.status === 409) {
    console.log(`gmod: #${pr.number} lands once ${base}'s required checks pass`);
    return 0;
  }
  console.log(`gmod: couldn't set #${pr.number} to land (${m.status}): ${JSON.stringify(m.json)}`);
  return 1;
}

if (event === 'pull_request' || event === 'pull_request_target') {
  if (payload.action === 'closed') process.exit(0);
  process.exit(await checkAndLand(payload.pull_request));
}

if (event === 'repository_dispatch' && payload.action === 'gmod') {
  const p = payload.client_payload ?? {};
  if (p.landed) process.exit(await afterMerge(p.landed));
  if (p.work) process.exit(await work());
  if (p.fix) process.exit(await fix(p.fix));
  if (p.check) {
    // Taking main in happens on GitHub's side, a moment after it's asked for.
    let pr;
    for (let i = 0; i < 12; i++) {
      pr = (await gh('GET', `/pulls/${p.check}`)).json;
      const c = await gh('GET', `/compare/${encodeURIComponent(pr.base.ref)}...${pr.head.sha}`);
      if (!c.ok || c.json.behind_by === 0) break;
      await sleep(5000);
    }
    if (!git('fetch', '-q', 'origin', `+refs/pull/${pr.number}/head:refs/remotes/pr/${pr.number}`) || !git('checkout', '-q', '--detach', pr.head.sha)) {
      console.log(`gmod: couldn't check out #${pr.number}`);
      process.exit(1);
    }
    process.exit(await checkAndLand(pr));
  }
}

if (event === 'issue_comment') process.exit(await mention());

if (event === 'push' || event === 'schedule' || event === 'workflow_dispatch') {
  process.exit(await afterMerge(process.env.GITHUB_SHA));
}

console.log(`gmod: nothing to do on ${event}`);

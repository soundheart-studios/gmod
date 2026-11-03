#!/usr/bin/env node
// The gmod action on GitHub: one step that does what the event calls for.
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
//
// From the action: GMOD_HOME (gmod itself), GMOD_GITHUB_TOKEN, and the
// reviewer's settings. From GitHub: GITHUB_* as usual.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.GMOD_HOME;
const token = process.env.GMOD_GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const event = process.env.GITHUB_EVENT_NAME;
const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const reviewer = !!(process.env.GMOD_REVIEW_URL || process.env.ANTHROPIC_API_KEY);
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

async function gh(method, path, body) {
  const res = await fetch(`${api}/repos/${repo}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
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
function afterMerge(sha) {
  const env = { GMOD_TOKEN: token, GMOD_SHA: sha, GMOD_FORGE: 'github' };
  const swept = run('bin/gmod.mjs', ['sweep']);
  const after = run('ci/after-merge.mjs', [], env);
  return swept || after;
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

  await status(sha, 'gmod / gate', 'pending', 'proving the change');
  // Reading main's rules needs only read access: CI's own token does.
  const gate = run('bin/gmod.mjs', ['verify', ...common, '--report', 'gate.md'], { GMOD_TOKEN: process.env.GMOD_FORGE_TOKEN || token });
  await status(sha, 'gmod / gate', gate === 0 ? 'success' : 'failure', gate === 0 ? 'proven' : 'not proven: see the gate comment');
  comment(pr.number, 'gmod-gate', 'gate.md');
  if (gate !== 0) return 1;

  if (reviewer) {
    await status(sha, 'gmod / review', 'pending', 'the AI is reading it');
    const labels = (pr.labels ?? []).map(l => l.name);
    const review = run('ci/review.mjs', [...common, '--report', 'review.md'], { GMOD_REVIEW_OVERRIDE: labels.includes('gmod-override') ? '1' : '0' });
    await status(sha, 'gmod / review', review === 0 ? 'success' : 'failure', review === 0 ? 'passed' : 'failed: see the review comment');
    comment(pr.number, 'gmod-review', 'review.md');
    if (review !== 0) return 1;
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
  const compare = await gh('GET', `/compare/${encodeURIComponent(pr.base.ref)}...${sha}`);
  if (compare.ok && compare.json.behind_by > 0) {
    // Behind main: proven against old code. Take main in, then check again.
    const up = await gh('PUT', `/pulls/${pr.number}/update-branch`, { expected_head_sha: sha });
    if (!up.ok) {
      console.log(`gmod: behind ${pr.base.ref}, and couldn't take it in (${up.status}): ${JSON.stringify(up.json)}`);
      return 1;
    }
    console.log(`gmod: ${pr.base.ref} moved on; #${pr.number} takes it in and is checked again`);
    await dispatch({ check: pr.number });
    return 0;
  }
  const merged = await gh('PUT', `/pulls/${pr.number}/merge`, { merge_method: 'merge', sha });
  if (!merged.ok) {
    console.log(`gmod: couldn't land #${pr.number} (${merged.status}): ${JSON.stringify(merged.json)}`);
    return 1;
  }
  console.log(`gmod: landed #${pr.number} on ${pr.base.ref}`);
  // What CI's own token merges starts no push run: start what follows a landing.
  await dispatch({ landed: merged.json.sha });
  return 0;
}

if (event === 'pull_request' || event === 'pull_request_target') {
  if (payload.action === 'closed') process.exit(0);
  process.exit(await checkAndLand(payload.pull_request));
}

if (event === 'repository_dispatch' && payload.action === 'gmod') {
  const p = payload.client_payload ?? {};
  if (p.landed) process.exit(afterMerge(p.landed));
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

if (event === 'push' || event === 'schedule' || event === 'workflow_dispatch') {
  process.exit(afterMerge(process.env.GITHUB_SHA));
}

console.log(`gmod: nothing to do on ${event}`);

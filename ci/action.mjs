#!/usr/bin/env node
// The gmod action on GitHub: one step that does what the event calls for.
//
//   pull_request   the gate, then the AI review, each reported as a check
//                  ("gmod / gate", "gmod / review") and a comment; then, if
//                  both passed on a gmod branch, it lands: merged by gmod,
//                  since many plans (free private repositories) have no
//                  auto-merge to ask for.
//   push, schedule claims on jobs done on main are let go.
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

async function status(sha, context, state, description) {
  const r = await gh('POST', `/statuses/${sha}`, { state, context, description: description.slice(0, 140), target_url: runUrl });
  if (!r.ok) console.log(`gmod: couldn't report ${context} (${r.status}): ${JSON.stringify(r.json)}`);
}

function comment(pr, marker, file) {
  run('ci/comment.mjs', ['--marker', marker, '--file', file], { GMOD_PR: String(pr), GMOD_TOKEN: token });
}

if (event === 'pull_request' || event === 'pull_request_target') {
  const pr = payload.pull_request;
  if (pr.head.repo?.full_name !== repo) {
    console.log('gmod: a pull request from a fork gets no secrets; nothing to check with');
    process.exit(0);
  }
  if (payload.action === 'closed') process.exit(0);
  const sha = pr.head.sha;
  const common = ['--base', pr.base.sha, '--head', 'HEAD', '--branch', pr.head.ref, '--title', pr.title];

  await status(sha, 'gmod / gate', 'pending', 'proving the change');
  const gate = run('bin/gmod.mjs', ['verify', ...common, '--report', 'gate.md'], { GMOD_TOKEN: process.env.GMOD_FORGE_TOKEN || '' });
  await status(sha, 'gmod / gate', gate === 0 ? 'success' : 'failure', gate === 0 ? 'proven' : 'not proven: see the gate comment');
  comment(pr.number, 'gmod-gate', 'gate.md');
  if (gate !== 0) process.exit(1);

  let review = 0;
  if (reviewer) {
    await status(sha, 'gmod / review', 'pending', 'the AI is reading it');
    const labels = (pr.labels ?? []).map(l => l.name);
    review = run('ci/review.mjs', [...common, '--report', 'review.md'], { GMOD_REVIEW_OVERRIDE: labels.includes('gmod-override') ? '1' : '0' });
    await status(sha, 'gmod / review', review === 0 ? 'success' : 'failure', review === 0 ? 'passed' : 'failed: see the review comment');
    comment(pr.number, 'gmod-review', 'review.md');
    if (review !== 0) process.exit(1);
  }

  // Land it: gmod's own branches only, and only on what was just checked.
  if (!pr.head.ref.startsWith('gmod/') || pr.draft) {
    console.log('gmod: passed; not a gmod branch (or a draft), so a person merges it');
    process.exit(0);
  }
  const now = await gh('GET', `/pulls/${pr.number}`);
  if (!now.ok || now.json.state !== 'open') process.exit(0);
  if (now.json.head.sha !== sha) {
    console.log('gmod: the branch moved while it was checked; the next run decides');
    process.exit(0);
  }
  const compare = await gh('GET', `/compare/${encodeURIComponent(pr.base.ref)}...${sha}`);
  if (compare.ok && compare.json.behind_by > 0) {
    // Behind main: it was proven against old code. Take main in; with a
    // person's token the checks run again by themselves.
    const up = await gh('PUT', `/pulls/${pr.number}/update-branch`, { expected_head_sha: sha });
    console.log(up.ok ? `gmod: ${pr.base.ref} moved on; the branch takes it in and is checked again` : `gmod: behind ${pr.base.ref}, and couldn't take it in (${up.status})`);
    process.exit(0);
  }
  const merged = await gh('PUT', `/pulls/${pr.number}/merge`, { merge_method: 'merge', sha });
  console.log(merged.ok ? `gmod: landed #${pr.number} on ${pr.base.ref}` : `gmod: couldn't land #${pr.number} (${merged.status}): ${JSON.stringify(merged.json)}`);
  process.exit(merged.ok ? 0 : 1);
}

if (event === 'push' || event === 'schedule' || event === 'workflow_dispatch') {
  process.exit(run('bin/gmod.mjs', ['sweep']));
}

console.log(`gmod: nothing to do on ${event}`);

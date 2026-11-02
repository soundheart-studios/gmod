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

// ---- 1. the tripwire ----
const parent = core.git(['rev-parse', '--verify', '-q', `${sha}^1`], { cwd: root, allow: true }).out;
const spec = parent ? core.protectSpec(root, parent) : null;
if (!spec) {
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
for (const pr of open.ok ? open.json ?? [] : []) {
  const ref = pr.head?.ref ?? '';
  if (!ref.startsWith('gmod/') || pr.head?.repo?.full_name !== repo) continue;
  const behind = !core.git(['merge-base', '--is-ancestor', sha, pr.head.sha], { cwd: root, allow: true }).ok;
  if (!behind) continue;
  const r = await call('POST', `/pulls/${pr.number}/update?style=merge`, null, updater || token);
  console.log(r.ok ? `after-merge: #${pr.number} (${ref}) takes ${main} in${updater ? '' : " (with CI's own token: its checks won't start again until it gets a new commit; set the GMOD_FORGE_TOKEN secret)"}` : `after-merge: #${pr.number} (${ref}) couldn't take ${main} in (${r.status}): ${JSON.stringify(r.json)}`);
}
process.exit(failed ? 1 : 0);

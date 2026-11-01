#!/usr/bin/env node
// Post a report on a pull request as one comment that later runs update in
// place: a hidden marker names it. Gitea's API (GitHub's is the same shape
// for these calls).
//
//   node ci/comment.mjs --marker gmod-gate --file gate.md
//
// From the CI environment: GITHUB_SERVER_URL (or GITEA_URL), GITHUB_REPOSITORY,
// GMOD_PR (the pull request's number), GMOD_TOKEN.
import { existsSync, readFileSync } from 'node:fs';

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const server = (process.env.GITEA_URL || process.env.GITHUB_SERVER_URL || '').replace(/\/$/, '');
const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.GMOD_PR;
const token = process.env.GMOD_TOKEN;
if (!flags.marker || !flags.file) {
  console.error('ci/comment.mjs --marker <name> --file <markdown>');
  process.exit(2);
}
if ((!server && !process.env.GITHUB_API_URL) || !repo || !pr || !token) {
  console.log('comment: not in a pull request with a token; skipped');
  process.exit(0);
}
if (!existsSync(flags.file)) {
  console.log(`comment: ${flags.file} wasn't written; skipped`);
  process.exit(0);
}

const marker = `<!-- ${flags.marker} -->`;
const body = `${marker}\n${readFileSync(flags.file, 'utf8')}`;
// GitHub and Gitea both say where their API is; Gitea's is under /api/v1.
const api = `${(process.env.GITHUB_API_URL || `${server}/api/v1`).replace(/\/$/, '')}/repos/${repo}`;
const headers = { authorization: `token ${token}`, 'content-type': 'application/json', accept: 'application/json' };

const res = await fetch(`${api}/issues/${pr}/comments`, { headers });
if (!res.ok) throw new Error(`listing comments: ${res.status} ${await res.text()}`);
const mine = (await res.json()).find(c => typeof c.body === 'string' && c.body.startsWith(marker));
const write = mine
  ? await fetch(`${api}/issues/comments/${mine.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
  : await fetch(`${api}/issues/${pr}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
if (!write.ok) throw new Error(`writing the comment: ${write.status} ${await write.text()}`);
console.log(`comment: ${mine ? 'updated' : 'posted'} ${flags.marker} on #${pr}`);

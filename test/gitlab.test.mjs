// gmod on GitLab: the forge from origin, the component's include, main's
// protection, and merge requests, against a stand-in glab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectForge, openPr, protectionMatches, setSecret } from '../lib/ci.mjs';
import { componentInclude, gitlabProtect, withComponent } from '../lib/gitlab.mjs';
import { isCiFile } from '../lib/core.mjs';

function repo(origin) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-gl-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

// A glab that answers from a table of "args" → {out, err, code}, and logs
// every call (with what came on stdin) to a file.
function fakeGlab(dir, answers) {
  const log = join(dir, 'glab.log');
  const table = join(dir, 'glab.json');
  writeFileSync(table, JSON.stringify(answers));
  const bin = join(dir, 'glab');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2).join(' ');
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
const t = JSON.parse(fs.readFileSync(${JSON.stringify(table)}, 'utf8'));
const key = Object.keys(t).find(k => args.includes(k));
const a = key ? t[key] : { code: 1, err: 'no answer for ' + args };
if (a.out) process.stdout.write(typeof a.out === 'string' ? a.out : JSON.stringify(a.out));
if (a.err) process.stderr.write(a.err);
process.exit(a.code ?? 0);
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) };
}
function withGlab(bin, fn) {
  const before = process.env.GMOD_GLAB;
  process.env.GMOD_GLAB = bin;
  return Promise.resolve(fn()).finally(() => { if (before === undefined) delete process.env.GMOD_GLAB; else process.env.GMOD_GLAB = before; });
}

test('GitLab, from origin: ssh, https, nested groups', () => {
  const cases = [
    ['git@gitlab.com:soundheart-studios/gmod-test-gl.git', { kind: 'gitlab', path: 'soundheart-studios/gmod-test-gl', api: 'https://gitlab.com/api/v4' }],
    ['https://gitlab.com/acme/platform/app.git', { kind: 'gitlab', path: 'acme/platform/app', repo: 'app' }],
    ['https://gitlab-ci-token:xyz@gitlab.com/acme/app.git', { kind: 'gitlab', path: 'acme/app', web: 'https://gitlab.com' }],
  ];
  for (const [url, want] of cases) {
    const dir = repo(url);
    try {
      const got = detectForge(dir);
      for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${url}: ${k}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a self-managed GitLab: named once in git config, or the instance a CI job runs on', () => {
  const dir = repo('git@git.acme.dev:team/app.git');
  try {
    execFileSync('git', ['-C', dir, 'config', 'gmod.git.acme.dev.kind', 'gitlab']);
    execFileSync('git', ['-C', dir, 'config', 'gmod.git.acme.dev.url', 'https://git.acme.dev']);
    const got = detectForge(dir);
    assert.equal(got.kind, 'gitlab');
    assert.equal(got.api, 'https://git.acme.dev/api/v4');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const ci = repo('https://gitlab-ci-token:x@code.example.org/a/b.git');
  const before = { ...process.env };
  Object.assign(process.env, { CI_SERVER_HOST: 'code.example.org', CI_SERVER_URL: 'https://code.example.org' });
  try {
    assert.equal(detectForge(ci).api, 'https://code.example.org/api/v4');
  } finally {
    for (const k of ['CI_SERVER_HOST', 'CI_SERVER_URL']) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    rmSync(ci, { recursive: true, force: true });
  }
});

test('.gitlab-ci.yml is CI: it travels alone and is reviewed', () => {
  assert.ok(isCiFile('.gitlab-ci.yml'));
  assert.ok(isCiFile('.gitlab/CODEOWNERS'));
  assert.ok(!isCiFile('src/gitlab-ci.mjs'));
});

test('the component include: pinned, with the reviewer chosen', () => {
  const y = componentInclude({ ref: 'v0.3.0', reviewer: { kind: 'openai', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } });
  assert.match(y, /component: gitlab\.com\/soundheart-studios\/gmod\/gmod@v0\.3\.0/);
  assert.match(y, /reviewer-url: https:\/\/api\.deepseek\.com\/v1/);
  assert.match(y, /reviewer-model: deepseek-flash/);
  assert.match(y, /review: blocking/);
  assert.match(componentInclude({ ref: 'v1', reviewer: { kind: 'none' } }), /review: off/);
  assert.match(componentInclude({ ref: 'v1', reviewer: { kind: 'claude' }, blocking: false }), /review: advice/);
});

test("the include goes into what's there: added on top, into an include list, or replacing an older gmod", () => {
  const block = componentInclude({ ref: 'v0.3.0', reviewer: { kind: 'none' } });
  const fresh = withComponent(null, block);
  assert.equal(fresh, block);
  const jobs = 'test:\n  script: [npm test]\n';
  const added = withComponent(jobs, block);
  assert.ok(added.startsWith(block) && added.endsWith(jobs));
  const list = withComponent('include:\n  - local: ci/other.yml\ntest:\n  script: [x]\n', block);
  assert.match(list, /^include:\n  - component: gitlab\.com\/soundheart-studios\/gmod\/gmod@v0\.3\.0\n    inputs:\n      review: off\n  - local: ci\/other\.yml/);
  const older = withComponent(componentInclude({ ref: 'v0.2.0', reviewer: { kind: 'none' } }) + jobs, block);
  assert.doesNotMatch(older, /@v0\.2\.0/);
  assert.equal(older.match(/component:/g).length, 1);
  assert.throws(() => withComponent('include: ci/other.yml\n', block), /include: gmod can't add to/);
});

const project = { id: 7, only_allow_merge_if_pipeline_succeeds: true, allow_merge_on_skipped_pipeline: false, merge_method: 'rebase_merge' };
const branch = { name: 'main', push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 30 }], allow_force_push: false };
const spec = { require: ['gate', 'review'], up_to_date: true };

test("main's protection, held to .gmod/protect.json on GitLab", async () => {
  const dir = repo('git@gitlab.com:acme/app.git');
  try {
    const ok = fakeGlab(dir, { 'protected_branches/main': { out: branch }, 'projects/acme%2Fapp': { out: project } });
    const good = await withGlab(ok.bin, () => protectionMatches(dir, { spec, main: 'main' }));
    assert.equal(good.ok, true, good.msg);
    assert.match(good.msg, /holds \.gmod\/protect\.json/);

    const weak = fakeGlab(dir, {
      'protected_branches/main': { out: { ...branch, push_access_levels: [{ access_level: 40 }], allow_force_push: true } },
      'projects/acme%2Fapp': { out: { ...project, only_allow_merge_if_pipeline_succeeds: false, allow_merge_on_skipped_pipeline: true, merge_method: 'merge' } },
    });
    const bad = await withGlab(weak.bin, () => protectionMatches(dir, { spec, main: 'main' }));
    assert.equal(bad.ok, false);
    for (const why of ['without a passing pipeline', 'skipped pipeline', "needn't be up to date", 'direct pushes', 'force pushes']) assert.match(bad.msg, new RegExp(why));

    const open = fakeGlab(dir, { 'protected_branches/main': { code: 1, err: 'GET .../protected_branches/main: 404 Not Found' }, 'projects/acme%2Fapp': { out: project } });
    const none = await withGlab(open.bin, () => protectionMatches(dir, { spec, main: 'main' }));
    assert.match(none.msg, /main isn't protected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gmod ci protect on GitLab: merge settings, then main protected so nobody pushes', async () => {
  const dir = repo('git@gitlab.com:acme/app.git');
  try {
    const g = fakeGlab(dir, {
      '-X PUT projects/acme%2Fapp': { out: project },
      '-X GET projects/acme%2Fapp/protected_branches/main': { out: { ...branch, push_access_levels: [{ access_level: 40 }] } },
      '-X DELETE projects/acme%2Fapp/protected_branches/main': { out: '' },
      '-X POST projects/acme%2Fapp/protected_branches': { out: branch },
    });
    await withGlab(g.bin, () => gitlabProtect({ forge: detectForge(dir), main: 'main' }));
    const calls = g.calls();
    const put = calls.find(c => c.args.includes('-X PUT'));
    assert.deepEqual(JSON.parse(put.input), { only_allow_merge_if_pipeline_succeeds: true, allow_merge_on_skipped_pipeline: false, merge_method: 'rebase_merge' });
    const post = calls.find(c => c.args.includes('-X POST'));
    assert.deepEqual(JSON.parse(post.input), { name: 'main', push_access_level: 0, merge_access_level: 30, allow_force_push: false });
    assert.ok(calls.findIndex(c => c.args.includes('DELETE')) < calls.indexOf(post), 'the old rule comes off first');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a merge request through glab, never set to merge from here', async () => {
  const dir = repo('git@gitlab.com:acme/app.git');
  const bare = mkdtempSync(join(tmpdir(), 'gmod-gl-bare-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', bare]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'main']);
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'gmod/slug']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'slug: turn titles into slugs']);
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'gmod/slug']);
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin']);
    const g = fakeGlab(dir, { 'mr create': { out: 'https://gitlab.com/acme/app/-/merge_requests/4\n' } });
    const forge = { kind: 'gitlab', host: 'gitlab.com', owner: 'acme', repo: 'app', path: 'acme/app', web: 'https://gitlab.com', api: 'https://gitlab.com/api/v4' };
    const r = await withGlab(g.bin, () => openPr(dir, { forge, branch: 'gmod/slug', auto: true, goal: 'slugs' }));
    assert.equal(r.number, 4);
    assert.equal(r.title, 'slug: turn titles into slugs');
    assert.equal(r.landing, 'the gmod-land job');
    const create = g.calls()[0];
    assert.match(create.args, /--repo acme\/app --source-branch gmod\/slug --target-branch main/);
    assert.doesNotMatch(create.args, /auto-merge/, 'landing is the pipeline\'s');
    assert.match(create.input, /\*\*slug\*\*: slugs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('a CI/CD variable through glab: masked, the value on stdin', async () => {
  const dir = repo('git@gitlab.com:acme/app.git');
  try {
    const g = fakeGlab(dir, { 'variable set': { out: '' } });
    await withGlab(g.bin, () => setSecret(dir, { name: 'GMOD_REVIEW_KEY', value: 's3cret' }));
    const [call] = g.calls();
    assert.equal(call.args, 'variable set GMOD_REVIEW_KEY --masked --repo acme/app');
    assert.equal(call.input, 's3cret');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

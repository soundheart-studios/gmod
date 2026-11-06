// gmod ci: put the gate and the reviewer into a repository's CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectForge, giteaToken, openPr, protectionMatches, setSecret, teaLogins, workflow } from '../lib/ci.mjs';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');

function repo(origin) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-ci-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}
function gmod(cwd, args, env = {}) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('the forge, from origin', () => {
  const cases = [
    ['git@github.com:acme/app.git', { kind: 'github', owner: 'acme', repo: 'app' }],
    ['https://github.com/acme/app', { kind: 'github', owner: 'acme', repo: 'app' }],
    ['ssh://acme@git.example.lan:2222/acme/gmod-demo.git', { kind: 'gitea', owner: 'acme', repo: 'gmod-demo', host: 'git.example.lan' }],
    ['http://git.example.lan:3000/acme/gmod-demo.git', { kind: 'gitea', owner: 'acme', repo: 'gmod-demo', web: 'http://git.example.lan:3000' }],
  ];
  for (const [url, want] of cases) {
    const dir = repo(url);
    try {
      const got = detectForge(dir);
      for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${url}: ${k}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('an ssh alias for GitHub (a second key) is still GitHub', () => {
  const dir = repo('git@github-2:acme/app.git');
  const config = join(dir, 'ssh_config');
  writeFileSync(config, 'Host github-2\n  HostName github.com\n  User git\n');
  const before = process.env.GMOD_SSH_CONFIG;
  process.env.GMOD_SSH_CONFIG = config;
  try {
    const got = detectForge(dir);
    assert.equal(got.kind, 'github');
    assert.equal(got.owner, 'acme');
    assert.equal(got.repo, 'app');
  } finally {
    if (before === undefined) delete process.env.GMOD_SSH_CONFIG; else process.env.GMOD_SSH_CONFIG = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow: GitHub, gmod from a pinned repo, Claude reviewing, comment only', () => {
  const y = workflow({ forge: 'github', gmod: { repo: 'acme/gmod', ref: 'v0.2.0' }, reviewer: { kind: 'claude' } });
  assert.match(y, /runs-on: ubuntu-latest/);
  assert.match(y, /repository: acme\/gmod, ref: v0\.2\.0, path: \.gmod-tool/);
  assert.match(y, /actions\/setup-node@v4/);
  assert.match(y, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.match(y, /npm install --prefix "\$GMOD_HOME"/, 'the SDK, for Claude');
  assert.match(y, /GMOD_REVIEW_MODE: comment/);
  assert.match(y, /pull-requests: write/);
  assert.match(y, /head\.repo\.full_name == github\.repository/, 'no secrets for forks');
});

test('the workflow: Gitea, a host runner, gmod on the host, a local model, blocking', () => {
  const y = workflow({ forge: 'gitea', runsOn: 'lan', gmod: { path: '/home/g/gmod-tool' }, reviewer: { kind: 'local', url: 'http://127.0.0.1:8080/v1', model: 'qwen' }, blocking: true });
  assert.match(y, /runs-on: lan/);
  assert.match(y, /GMOD_HOME: \/home\/g\/gmod-tool/);
  assert.doesNotMatch(y, /setup-node/, 'the host has node');
  assert.match(y, /GMOD_REVIEW_URL: http:\/\/127\.0\.0\.1:8080\/v1/);
  assert.match(y, /GMOD_REVIEW_MODEL: qwen/);
  assert.doesNotMatch(y, /GMOD_REVIEW_MODE: comment/);
  assert.doesNotMatch(y, /ANTHROPIC|npm install/);
});

test('the workflow: no reviewer means no review job', () => {
  const y = workflow({ forge: 'gitea', runsOn: 'x', gmod: { path: '/g' }, reviewer: { kind: 'none' } });
  assert.match(y, /\n  gate:/);
  assert.doesNotMatch(y, /\n  review:/);
});

test('gmod ci init writes the workflow and CODEOWNERS, and never overwrites', () => {
  const dir = repo('ssh://acme@git.example.lan:2222/acme/gmod-demo.git');
  try {
    const r = gmod(dir, ['ci', 'init', '--runs-on', 'lan', '--gmod-home', '/g', '--reviewer', 'local', '--review-url', 'http://127.0.0.1:8080/v1', '--owners', '@acme']);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(join(dir, '.gitea/workflows/gmod.yml'), 'utf8'), /runs-on: lan/);
    // The plan and the workflow both belong to the owners: a pull request
    // runs its own copy of the workflow, so it could weaken its own gate.
    assert.equal(readFileSync(join(dir, '.gitea/CODEOWNERS'), 'utf8'), '/.gmod/ @acme\n/.gitea/ @acme\n');
    assert.match(r.out, /wrote \.gitea\/workflows\/gmod\.yml/);
    const again = gmod(dir, ['ci', 'init', '--runs-on', 'lan', '--gmod-home', '/g']);
    assert.equal(again.code, 1);
    assert.match(again.err, /already exists.*--force/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A stand-in for Gitea's API: records what it's asked, answers like Gitea.
function fakeGitea(state) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/v1/repos/acme/demo/branch_protections/main') {
        if (req.method === 'GET') return state.rule ? send(200, state.rule) : send(404, {});
        if (req.method === 'PATCH') return send(200, (state.rule = { ...state.rule, ...JSON.parse(body) }));
      }
      if (req.url === '/api/v1/repos/acme/demo/branch_protections' && req.method === 'POST') return send(201, (state.rule = JSON.parse(body)));
      if (req.url === '/api/v1/repos/acme/demo/actions/runners') return send(200, { runners: state.runners ?? [] });
      if (req.url === '/api/v1/user/actions/runners') return send(200, { runners: [] });
      if (req.url === '/api/v1/admin/actions/runners' && state.notAdmin) return send(403, { message: 'token does not have required scope: read:admin' });
      if (req.url === '/api/v1/admin/actions/runners') return send(200, { runners: state.instanceRunners ?? [] });
      if (req.url === '/api/v1/repos/acme/demo/pulls' && req.method === 'POST') {
        const b = JSON.parse(body);
        if ((state.pulls ??= []).some(p => p.head.ref === b.head)) return send(409, { message: 'pull request already exists for these targets' });
        const pr = { number: state.pulls.length + 1, title: b.title, body: b.body, base: { ref: b.base }, head: { ref: b.head }, html_url: `http://gitea/acme/demo/pulls/${state.pulls.length + 1}` };
        state.pulls.push(pr);
        return send(201, pr);
      }
      if (/^\/api\/v1\/repos\/acme\/demo\/pulls\/\d+\/merge$/.test(req.url) && req.method === 'POST') return send(200, {});
      if (req.url.startsWith('/api/v1/repos/acme/demo/pulls?')) return send(200, state.pulls ?? []);
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'qwen' }] });
      send(404, {});
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('gmod ci protect: on Gitea, require the gate and up-to-date branches, no direct pushes', async () => {
  const state = {};
  const api = await fakeGitea(state);
  const dir = repo(`${api.url}/acme/demo.git`);
  try {
    writeFileSync(join(dir, 'tok'), 'secret-token\n');
    const r = await new Promise(ok => {
      const p = spawnSyncAsync(dir, ['ci', 'protect', '--token-file', join(dir, 'tok')]);
      p.then(ok);
    });
    assert.equal(r.code, 0, r.err);
    const post = api.seen.find(s => s.method === 'POST');
    assert.equal(post.auth, 'token secret-token');
    assert.deepEqual(
      [post.body.rule_name, post.body.enable_push, post.body.enable_status_check, post.body.status_check_contexts, post.body.block_on_outdated_branch],
      ['main', false, true, ['gmod / gate (pull_request)'], true],
    );
    // What main declares is what's applied, without the flag.
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'a@x.io']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'a']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'seed']);
    execFileSync('mkdir', ['-p', join(dir, '.gmod')]);
    writeFileSync(join(dir, '.gmod', 'protect.json'), JSON.stringify({ require: ['gate', 'review'] }));
    await spawnSyncAsync(dir, ['ci', 'protect', '--token-file', join(dir, 'tok')]);
    assert.deepEqual(api.seen.at(-1).body.status_check_contexts, ['gmod / gate (pull_request)', 'gmod / review (pull_request)']);
    rmSync(join(dir, '.gmod'), { recursive: true });
    // Run again: the rule is updated in place, not duplicated.
    await spawnSyncAsync(dir, ['ci', 'protect', '--token-file', join(dir, 'tok')]);
    assert.equal(api.seen.filter(s => s.method === 'POST').length, 1);
    assert.equal(api.seen.filter(s => s.method === 'PATCH').length, 2);
  } finally { api.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('gmod ci check: says what is in place and what is missing', async () => {
  const state = { rule: { rule_name: 'main', enable_status_check: true, status_check_contexts: ['gmod / gate (pull_request)'], block_on_outdated_branch: true, enable_push: false } };
  const api = await fakeGitea(state);
  const dir = repo(`${api.url}/acme/demo.git`);
  try {
    writeFileSync(join(dir, 'tok'), 'secret-token\n');
    gmod(dir, ['ci', 'init', '--runs-on', 'lan', '--gmod-home', '/g', '--reviewer', 'local', '--review-url', `${api.url}/v1`]);
    let r = await spawnSyncAsync(dir, ['ci', 'check', '--token-file', join(dir, 'tok')]);
    assert.equal(r.code, 1, 'no runner yet');
    assert.match(r.out, /✅ the workflow is in \.gitea\/workflows\/gmod\.yml/);
    assert.match(r.out, /✅ main requires the gate and up-to-date branches/);
    assert.match(r.out, /✅ the reviewer answers at/);
    assert.match(r.out, /❌ no runner with the label lan/);
    state.runners = [{ name: 'box', status: 'online', labels: [{ name: 'lan' }] }];
    r = await spawnSyncAsync(dir, ['ci', 'check', '--token-file', join(dir, 'tok')]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✅ runner box \(online\) has the label lan/);
    // A runner registered for the whole instance counts too.
    state.runners = [];
    state.instanceRunners = [{ name: 'shared', status: 'online', labels: [{ name: 'lan' }] }];
    r = await spawnSyncAsync(dir, ['ci', 'check', '--token-file', join(dir, 'tok')]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✅ runner shared \(online\) has the label lan \(the instance's\)/);
    // A token without read:admin can't see those: say so, don't say there is none.
    state.notAdmin = true;
    r = await spawnSyncAsync(dir, ['ci', 'check', '--token-file', join(dir, 'tok')]);
    assert.match(r.out, /❌ no runner with the label lan in .*; the instance's runners need a token with read:admin/);
  } finally { api.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

// The fake server runs in this process, so the CLI must run alongside it.
import { spawn } from 'node:child_process';
function spawnSyncAsync(cwd, args, env = {}) {
  return new Promise(ok => {
    const p = spawn('node', [GMOD, ...args], { cwd, env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => ok({ code, out: out.trim(), err: err.trim() }));
  });
}

test('gmod pr: the token from ~/.config, the address from git config, titled by the job commit, once', async () => {
  const api = await fakeGitea({});
  const top = mkdtempSync(join(tmpdir(), 'gmod-pr-'));
  try {
    // origin is ssh, as on git.example.lan; a stand-in ssh runs git on a local bare repository.
    const bare = join(top, 'acme', 'demo.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const ssh = join(top, 'ssh');
    writeFileSync(ssh, `#!/bin/sh\nshift\nexec sh -c "$(echo "$*" | sed "s#'/acme/#'${top}/acme/#")"\n`, { mode: 0o755 });
    const home = join(top, 'home');
    mkdirSync(join(home, '.config', 'gmod'), { recursive: true });
    writeFileSync(join(home, '.config', 'gmod', 'gitea-token'), 'tok-from-config\n');
    const env = { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: 'simple', GITEA_TOKEN: '' };
    const dir = repo('ssh://git@fakehost/acme/demo.git');
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, ...env }, encoding: 'utf8' });
    g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
    g('config', '--global', 'gmod.fakehost.url', api.url);
    mkdirSync(join(dir, '.gmod', 'journal'), { recursive: true });
    writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify({ main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], done_when: [{ text: 'adds', check: 'ok' }] }] }));
    g('add', '-A'); g('commit', '-q', '-m', 'seed'); g('push', '-q', 'origin', 'HEAD:main'); g('fetch', '-q', 'origin');
    g('checkout', '-q', '-b', 'gmod/add-sum');
    writeFileSync(join(dir, '.gmod', 'journal', 'add-sum.md'), '# add-sum: Add two numbers\n\n- t alice: tried the obvious\n');
    g('add', '-A'); g('commit', '-q', '-m', 'add-sum: sum adds');

    let r = await spawnSyncAsync(dir, ['pr'], env);
    assert.equal(r.code, 1);
    assert.match(r.err, /git push -u origin gmod\/add-sum/);

    g('push', '-q', 'origin', 'gmod/add-sum');
    r = await spawnSyncAsync(dir, ['pr', '--job', 'add-sum'], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^opened: http:\/\/gitea\/acme\/demo\/pulls\/1\nadd-sum: sum adds$/);
    const post = api.seen.find(x => x.method === 'POST');
    assert.equal(post.auth, 'token tok-from-config');
    assert.deepEqual([post.body.head, post.body.base, post.body.title], ['gmod/add-sum', 'main', 'add-sum: sum adds']);
    assert.match(post.body.body, /\*\*add-sum\*\*: Add two numbers[\s\S]*### Journal[\s\S]*tried the obvious/);

    r = await spawnSyncAsync(dir, ['pr'], env);
    assert.match(r.out, /^already open: http:\/\/gitea\/acme\/demo\/pulls\/1/);
    assert.equal(api.seen.filter(x => x.url.endsWith('/merge')).length, 0);

    // --auto: Gitea merges it once the checks pass.
    r = await spawnSyncAsync(dir, ['pr', '--auto'], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /merges by itself once its checks pass/);
    const merge = api.seen.find(x => x.url === '/api/v1/repos/acme/demo/pulls/1/merge');
    assert.deepEqual(merge.body, { Do: 'merge', merge_when_checks_succeed: true });

    // A plan change lands on green too: the gate and the review judge it.
    g('checkout', '-q', '-b', 'gmod/plan-more', 'origin/main');
    writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify({ main: 'main', checks: { ok: 'true' }, jobs: [] }));
    g('commit', '-q', '-am', 'plan: drop add-sum'); g('push', '-q', 'origin', 'gmod/plan-more');
    r = await spawnSyncAsync(dir, ['pr', '--auto', '--job', 'plan'], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /merges by itself once its checks pass/);
  } finally { api.server.close(); rmSync(top, { recursive: true, force: true }); }
});

test('the workflow compares against the pull request base, and checks what landed', () => {
  const y = workflow({ forge: 'gitea', runsOn: 'lan', gmod: { path: '/g' }, reviewer: { kind: 'local', url: 'http://m/v1' }, blocking: true });
  assert.match(y, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(y, /verify --base "\$\{BASE_SHA:-origin\/\$BASE\}"/);
  assert.match(y, /BASE_SHA: .*\n {10}GMOD_TOKEN: \$\{\{ secrets\.GMOD_FORGE_TOKEN \}\}\n {6}- name: Post it/);
  assert.match(y, /review\.mjs" --base "\$\{BASE_SHA:-origin\/\$BASE\}"/);
  assert.match(y, /ci\/after-merge\.mjs"\n {8}env:\n {10}GMOD_TOKEN: \$\{\{ github\.token \}\}\n {10}GMOD_FORGE_TOKEN: \$\{\{ secrets\.GMOD_FORGE_TOKEN \}\}\n {10}GMOD_SHA: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(y, /GMOD_REVIEW_MODE/);
  // Hourly, the sweep looks for what isn't landing.
  assert.match(y, /\n {2}schedule:\n {4}- cron: '17 \* \* \* \*'\n/);
  assert.match(y, /sweep:\n {4}if: github\.event_name == 'push' \|\| github\.event_name == 'schedule'/);
});

test("the workflow installs the project's own dependencies before the gate and the review", () => {
  const y = workflow({ forge: 'gitea', runsOn: 'lan', gmod: { path: '/g' }, reviewer: { kind: 'local', url: 'http://m/v1' }, setup: 'uv sync --frozen\nnpm --prefix web ci' });
  const step = '      - name: Install project dependencies\n        run: |\n          uv sync --frozen\n          npm --prefix web ci\n';
  assert.equal(y.split(step).length, 3, 'once in the gate, once in the review');
  assert.ok(y.indexOf(step) < y.indexOf('The deterministic gate'));
  assert.doesNotMatch(workflow({ forge: 'gitea', runsOn: 'x', gmod: { path: '/g' } }), /Install project dependencies/);
});

test("main's live protection is held to .gmod/protect.json", async () => {
  const state = { rule: { enable_status_check: true, status_check_contexts: ['gmod / gate (pull_request)'], block_on_outdated_branch: true, enable_push: false } };
  const api = await fakeGitea(state);
  const dir = repo(`${api.url}/acme/demo.git`);
  try {
    const spec = { require: ['gate', 'review'], up_to_date: true };
    let f = await protectionMatches(dir, { spec, token: 't' });
    assert.equal(f.ok, false);
    assert.match(f.msg, /weaker than \.gmod\/protect\.json: the review isn't required by its exact name/);
    // A pattern matches the skipped "(push)" statuses too: weaker, not equal.
    state.rule.status_check_contexts.push('gmod / review*');
    f = await protectionMatches(dir, { spec, token: 't' });
    assert.match(f.msg, /gmod \/ review\* is a pattern a skipped status satisfies/);
    state.rule.status_check_contexts = ['gmod / gate (pull_request)', 'gmod / review (pull_request)'];
    f = await protectionMatches(dir, { spec, token: 't' });
    assert.equal(f.ok, true, f.msg);
    state.rule.enable_push = true;
    state.rule.block_on_outdated_branch = false;
    f = await protectionMatches(dir, { spec, token: 't' });
    assert.match(f.msg, /branches needn't be up to date, direct pushes are allowed/);
    assert.equal(await protectionMatches(dir, { spec: null, token: 't' }), null);
    assert.match((await protectionMatches(dir, { spec })).msg, /no token/);
  } finally { api.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('after a merge: a breach opens an issue, and behind job branches take main in', async () => {
  const dir = repo();
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify({ main: 'main', checks: {}, jobs: [] }));
  writeFileSync(join(dir, '.gmod', 'protect.json'), JSON.stringify({ require: ['gate', 'review'] }));
  g('add', '-A'); g('commit', '-q', '-m', 'governance');
  const before = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'x'), 'x\n'); g('add', '-A'); g('commit', '-q', '-m', 'landed');
  const landed = g('rev-parse', 'HEAD');

  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const base = '/api/v1/repos/acme/demo';
      if (req.url.startsWith(`${base}/pulls?state=closed`)) return send(200, [{ number: 7, merged: true, merge_commit_sha: landed, head: { sha: 'h7' } }]);
      if (req.url === `${base}/commits/h7/status`) return send(200, { statuses: [{ context: 'gmod / review (pull_request)', status: 'failure' }, { context: 'gmod / gate (pull_request)', status: 'success' }] });
      if (req.url === `${base}/issues` && req.method === 'POST') return send(201, { number: 9 });
      if (req.url.startsWith(`${base}/pulls?state=open`)) return send(200, [
        { number: 8, head: { ref: 'gmod/behind', sha: before, repo: { full_name: 'acme/demo' } } },
        { number: 10, head: { ref: 'gmod/current', sha: landed, repo: { full_name: 'acme/demo' } } },
        { number: 11, head: { ref: 'someone-else', sha: before, repo: { full_name: 'acme/demo' } } },
      ]);
      if (req.url === `${base}/pulls/8/update?style=merge`) return send(200, {});
      send(404, {});
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await new Promise(ok => {
      const p = spawn('node', [join(dirname(GMOD), '..', 'ci', 'after-merge.mjs')], { cwd: dir, env: { ...process.env, GITHUB_SERVER_URL: url, GITHUB_REPOSITORY: 'acme/demo', GMOD_TOKEN: 't', GMOD_SHA: landed, GITHUB_API_URL: '' } });
      let out = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (out += d));
      p.on('close', code => ok({ code, out }));
    });
    assert.equal(r.code, 1, r.out);
    const issue = seen.find(x => x.url.endsWith('/issues') && x.method === 'POST');
    assert.match(issue.body.title, /^gmod breach: #7 merged with its review failure$/);
    assert.match(r.out, /#8 \(gmod\/behind\) takes main in/);
    assert.equal(seen.filter(x => x.url.includes('/update')).length, 1, 'only the job branch that is behind');
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('what is not landing gets a "gmod stuck" issue, closed once it is gone', async () => {
  const dir = repo();
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify({ main: 'main', checks: {}, jobs: [] }));
  writeFileSync(join(dir, '.gmod', 'protect.json'), JSON.stringify({ require: ['gate', 'review'] }));
  g('add', '-A'); g('commit', '-q', '-m', 'governance');
  const head = g('rev-parse', 'HEAD');
  const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();
  // A claim taken long ago, with no pull request; and a fresh one.
  for (const [job, h] of [['old-claim', 30], ['new-claim', 1]]) {
    const obj = execFileSync('git', ['-C', dir, 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', JSON.stringify({ job, by: 'agent@x', at: hoursAgo(h) })], { encoding: 'utf8' }).trim();
    g('update-ref', `refs/gmod/claims/${job}`, obj);
  }
  const pr = (number, job, sha, h) => ({ number, updated_at: hoursAgo(h), head: { ref: `gmod/${job}`, sha, repo: { full_name: 'acme/demo' } } });
  const statuses = {
    failing: [{ context: 'gmod / review (pull_request)', status: 'failure', updated_at: hoursAgo(5) }, { context: 'gmod / gate (pull_request)', status: 'success', updated_at: hoursAgo(5) }],
    fresh: [{ context: 'gmod / review (pull_request)', status: 'failure', updated_at: hoursAgo(0.2) }],
    green: [{ context: 'gmod / review (pull_request)', status: 'success', updated_at: hoursAgo(3) }, { context: 'gmod / gate (pull_request)', status: 'success', updated_at: hoursAgo(3) }],
    hung: [{ context: 'gmod / gate (pull_request)', status: 'pending', updated_at: hoursAgo(4) }],
  };
  const seen = [];
  // Every pull request's head is the same commit here: statuses are answered
  // in the order the pull requests were listed.
  let asked = 0;
  const order = ['failing', 'fresh', 'green', 'hung'];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const base = '/api/v1/repos/acme/demo';
      if (req.url.startsWith(`${base}/pulls?state=open`)) return send(200, [pr(20, 'failing', head, 5), pr(21, 'fresh', head, 0.2), pr(22, 'green', head, 3), pr(23, 'hung', head, 4)]);
      if (/\/status$/.test(req.url)) return send(200, { statuses: statuses[order[asked++]] });
      if (req.url.startsWith(`${base}/issues?state=open`)) return send(200, [{ number: 30, title: 'gmod stuck: landed-job' }, { number: 31, title: 'gmod stuck: failing' }, { number: 32, title: 'something else' }]);
      if (req.url === `${base}/issues` && req.method === 'POST') return send(201, { number: 40 });
      if (req.url.startsWith(`${base}/issues/`)) return send(201, {});
      send(404, {});
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await new Promise(ok => {
      const p = spawn('node', [join(dirname(GMOD), '..', 'ci', 'after-merge.mjs')], { cwd: dir, env: { ...process.env, GITHUB_SERVER_URL: url, GITHUB_REPOSITORY: 'acme/demo', GMOD_TOKEN: 't', GMOD_SHA: head, GITHUB_API_URL: '', GITHUB_EVENT_NAME: 'schedule' } });
      let out = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (out += d));
      p.on('close', code => ok({ code, out }));
    });
    assert.equal(r.code, 0, r.out);
    assert.ok(!seen.some(x => x.url.includes('/pulls?state=closed')), 'the hourly look checks no merge');
    const opened = seen.filter(x => x.method === 'POST' && x.url.endsWith('/issues')).map(x => x.body);
    assert.deepEqual(opened.map(i => i.title).sort(), ['gmod stuck: green', 'gmod stuck: hung', 'gmod stuck: old-claim']);
    assert.match(opened.find(i => i.title.endsWith('green')).body, /#22 passed everything 3h ago but hasn't merged/);
    assert.match(opened.find(i => i.title.endsWith('hung')).body, /#23's checks haven't finished in 4h \(gate pending, review missing\)\. Is the runner up\?/);
    assert.match(opened.find(i => i.title.endsWith('old-claim')).body, /claimed by agent@x 30h ago, and no pull request yet/);
    assert.match(r.out, /failing is still stuck \(#31\)/, 'filed once, not again every hour');
    assert.ok(!r.out.includes('fresh'), 'a failure from minutes ago is still being worked on');
    assert.ok(seen.some(x => x.method === 'PATCH' && x.url.endsWith('/issues/30') && x.body.state === 'closed'), 'a job no longer waiting has its issue closed');
    assert.ok(!seen.some(x => x.url.endsWith('/issues/31') || x.url.endsWith('/issues/32')));
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('on GitHub, opening a pull request to land on green never merges it from here', async () => {
  // gh pr merge --auto on a repository with no required checks merges at
  // once, before anything has run: landing is the gmod action's alone.
  const root = mkdtempSync(join(tmpdir(), 'gmod-ghpr-'));
  const bare = join(root, 'origin.git');
  const dir = join(root, 'work');
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, dir], { stdio: 'ignore' });
  g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
  writeFileSync(join(dir, 'README.md'), 'x\n'); g('add', '-A'); g('commit', '-q', '-m', 'seed'); g('push', '-q', 'origin', 'main');
  g('switch', '-q', '-c', 'gmod/add-sum');
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
  g('add', '-A'); g('commit', '-q', '-m', 'add-sum: adds'); g('push', '-q', '-u', 'origin', 'gmod/add-sum');
  const log = join(root, 'gh.log');
  const fake = join(root, 'gh');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\ncat >/dev/null\necho https://github.com/acme/app/pull/7\n`, { mode: 0o755 });
  const before = process.env.GMOD_GH;
  process.env.GMOD_GH = fake;
  try {
    const r = await openPr(dir, { forge: { kind: 'github', owner: 'acme', repo: 'app' }, job: 'add-sum', goal: 'Adds', auto: true });
    assert.equal(r.url, 'https://github.com/acme/app/pull/7');
    assert.equal(r.landing, 'the gmod action');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.some(c => c.startsWith('pr create')), calls.join('; '));
    assert.ok(!calls.some(c => c.startsWith('pr merge')), `nothing merges from here: ${calls.join('; ')}`);
  } finally {
    if (before === undefined) delete process.env.GMOD_GH; else process.env.GMOD_GH = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test('after a merge on GitHub: the tripwire, catch-up that starts its own checks, and stuck reports', async () => {
  const dir = repo();
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify({ main: 'main', checks: {}, jobs: [] }));
  writeFileSync(join(dir, '.gmod', 'protect.json'), JSON.stringify({ require: ['gate', 'review'] }));
  g('add', '-A'); g('commit', '-q', '-m', 'governance');
  writeFileSync(join(dir, 'x'), 'x\n'); g('add', '-A'); g('commit', '-q', '-m', 'landed');
  const landed = g('rev-parse', 'HEAD');
  const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();

  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const base = '/repos/acme/app';
      if (req.url === `${base}/commits/${landed}/pulls`) return send(200, [{ number: 4, merged_at: hoursAgo(0), merge_commit_sha: landed, head: { sha: 'h4' } }]);
      // GitHub's combined status: "state", and no "(pull_request)" in the name.
      if (req.url === `${base}/commits/h4/status`) return send(200, { statuses: [{ context: 'gmod / gate', state: 'success' }, { context: 'gmod / review', state: 'failure' }] });
      if (req.url.startsWith(`${base}/pulls?state=open`)) return send(200, [
        { number: 8, updated_at: hoursAgo(0.1), head: { ref: 'gmod/behind', sha: 'h8', repo: { full_name: 'acme/app' } } },
        { number: 9, updated_at: hoursAgo(5), head: { ref: 'gmod/failing', sha: 'h9', repo: { full_name: 'acme/app' } } },
      ]);
      if (req.url === `${base}/compare/main...h8`) return send(200, { behind_by: 1 });
      if (req.url === `${base}/compare/main...h9`) return send(200, { behind_by: 0 });
      if (req.url === `${base}/pulls/8/update-branch` && req.method === 'PUT') return send(202, {});
      if (req.url === `${base}/dispatches` && req.method === 'POST') { res.writeHead(204); return res.end(); }
      if (req.url === `${base}/commits/h8/status`) return send(200, { statuses: [] });
      if (req.url === `${base}/commits/h9/status`) return send(200, { statuses: [{ context: 'gmod / review', state: 'failure', updated_at: hoursAgo(5) }] });
      // GitHub lists pull requests among issues.
      if (req.url.startsWith(`${base}/issues?state=open`)) return send(200, [{ number: 9, title: 'gmod stuck: failing', pull_request: {} }]);
      if (req.url === `${base}/issues` && req.method === 'POST') return send(201, { number: 20 + seen.length });
      send(404, {});
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await new Promise(ok => {
      const p = spawn('node', [join(dirname(GMOD), '..', 'ci', 'after-merge.mjs')], { cwd: dir, env: { ...process.env, GMOD_FORGE: 'github', GITHUB_API_URL: url, GITHUB_SERVER_URL: '', GITHUB_REPOSITORY: 'acme/app', GMOD_TOKEN: 't', GMOD_SHA: landed, GMOD_FORGE_TOKEN: '', GITHUB_EVENT_NAME: 'repository_dispatch' } });
      let out = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (out += d));
      p.on('close', code => ok({ code, out }));
    });
    assert.equal(r.code, 1, r.out);
    assert.ok(seen.every(x => x.auth === 'Bearer t'), 'GitHub takes a bearer token');
    const opened = seen.filter(x => x.method === 'POST' && x.url.endsWith('/issues')).map(x => x.body.title);
    assert.ok(opened.includes('gmod breach: #4 merged with its review failure'), opened.join('; '));
    assert.ok(seen.some(x => x.method === 'PUT' && x.url.endsWith('/pulls/8/update-branch') && x.body.expected_head_sha === 'h8'));
    const d = seen.find(x => x.url.endsWith('/dispatches'));
    assert.deepEqual(d.body, { event_type: 'gmod', client_payload: { check: 8 } }, "CI's own token can start a run only this way");
    assert.match(r.out, /#8 \(gmod\/behind\) takes main in; its checks are started again/);
    assert.ok(!seen.some(x => x.url.endsWith('/pulls/9/update-branch')), 'a branch that is current is left alone');
    assert.ok(opened.includes('gmod stuck: failing'), 'a pull request listed among issues is not a stuck issue already filed');
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('GitHub: main is held to .gmod/protect.json through its ruleset, or by the tripwire on a free private repository', async () => {
  let reply = { status: 200, body: [] };
  const server = createServer((req, res) => {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  const forge = { kind: 'github', owner: 'acme', repo: 'app' };
  const spec = { require: ['gate', 'review'], up_to_date: true };
  const check = () => protectionMatches('/nowhere', { spec, token: 't', forge });
  try {
    const { githubRuleset } = await import('../lib/ci.mjs');
    // The ruleset gmod ci protect makes, as the rules API reports it.
    reply = { status: 200, body: githubRuleset({ main: 'main', requireReview: true }).rules };
    let f = await check();
    assert.equal(f.ok, true, f.msg);
    reply = { status: 200, body: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'gmod / gate' }] } }] };
    f = await check();
    assert.equal(f.ok, false);
    assert.match(f.msg, /the review isn't required by its exact name, branches needn't be up to date, direct pushes are allowed, force pushes are allowed/);
    reply = { status: 403, body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } };
    f = await check();
    assert.equal(f.ok, true, 'a plan without protection is not a reason to refuse every pull request');
    assert.match(f.msg, /the after-merge tripwire holds it/);
    reply = { status: 500, body: { message: 'oops' } };
    assert.equal((await check()).ok, false, 'an unreadable answer is not a pass');
  } finally {
    if (before === undefined) delete process.env.GITHUB_API_URL; else process.env.GITHUB_API_URL = before;
    server.close();
  }
});

test("a Gitea token comes from tea's login for that host when there is one", () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-tea-'));
  const config = join(dir, 'config.yml');
  writeFileSync(config, [
    'logins:',
    '- name: work',
    '  url: https://git.example.com',
    '  token: work-token',
    '  default: true',
    '  user: me',
    '- name: home',
    "  url: 'http://git.example.lan:3000'",
    '  token: "home-token"',
    'preferences:',
    '  editor: false',
  ].join('\n'));
  try {
    assert.deepEqual(teaLogins(readFileSync(config, 'utf8')).map(l => [l.name, l.token, l.default]), [['work', 'work-token', true], ['home', 'home-token', false]]);
    const none = join(dir, 'missing');
    assert.equal(giteaToken({ env: {}, teaConfigs: [config], fallback: none, web: 'http://git.example.lan:3000' }), 'home-token', 'the login for that host');
    assert.equal(giteaToken({ env: {}, teaConfigs: [config], fallback: none }), 'work-token', 'no host known: the default login');
    assert.equal(giteaToken({ env: { GITEA_TOKEN: 'env' }, teaConfigs: [config], fallback: none, web: 'http://git.example.lan:3000' }), 'env', 'GITEA_TOKEN still wins');
    const own = join(dir, 'gitea-token');
    writeFileSync(own, 'file-token\n');
    assert.equal(giteaToken({ env: {}, teaConfigs: [none], fallback: own }), 'file-token', "gmod's own file, when tea has nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a CI secret goes through gh on GitHub and the API on Gitea, never a command line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-secret-'));
  const log = join(dir, 'gh.log');
  const fake = join(dir, 'gh');
  writeFileSync(fake, `#!/bin/sh\necho "args: $@" >> '${log}'\necho "stdin: $(cat)" >> '${log}'\n`, { mode: 0o755 });
  const before = process.env.GMOD_GH;
  process.env.GMOD_GH = fake;
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => { seen.push({ method: req.method, url: req.url, body: JSON.parse(body || '{}') }); res.writeHead(201); res.end('{}'); });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    await setSecret('/nowhere', { name: 'GMOD_REVIEW_KEY', value: 'sk-value', forge: { kind: 'github', owner: 'acme', repo: 'app' } });
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /args: secret set GMOD_REVIEW_KEY --repo acme\/app/);
    assert.match(calls, /stdin: sk-value/);
    assert.ok(!/args: .*sk-value/.test(calls), 'the value is never an argument');
    const web = `http://127.0.0.1:${server.address().port}`;
    await setSecret('/nowhere', { name: 'GMOD_REVIEW_KEY', value: 'sk-value', token: 't', forge: { kind: 'gitea', owner: 'acme', repo: 'app', web, api: `${web}/api/v1` } });
    assert.deepEqual(seen.map(x => [x.method, x.url, x.body.data]), [['PUT', '/api/v1/repos/acme/app/actions/secrets/GMOD_REVIEW_KEY', 'sk-value']]);
    await assert.rejects(setSecret('/nowhere', { name: 'bad name', value: 'x', forge: { kind: 'github' } }), /letters, digits and _/);
    await assert.rejects(setSecret('/nowhere', { name: 'OK', value: '', forge: { kind: 'github' } }), /pipe it in/);
  } finally {
    if (before === undefined) delete process.env.GMOD_GH; else process.env.GMOD_GH = before;
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

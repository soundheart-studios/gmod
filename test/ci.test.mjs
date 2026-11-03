// gmod ci: put the gate and the reviewer into a repository's CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectForge, protectionMatches, workflow } from '../lib/ci.mjs';

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
    ['ssh://acme@ai.local:2222/acme/gmod-demo.git', { kind: 'gitea', owner: 'acme', repo: 'gmod-demo', host: 'ai.local' }],
    ['http://ai.local:3000/acme/gmod-demo.git', { kind: 'gitea', owner: 'acme', repo: 'gmod-demo', web: 'http://ai.local:3000' }],
  ];
  for (const [url, want] of cases) {
    const dir = repo(url);
    try {
      const got = detectForge(dir);
      for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${url}: ${k}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
  const y = workflow({ forge: 'gitea', runsOn: 'ai-local', gmod: { path: '/home/g/gmod-tool' }, reviewer: { kind: 'local', url: 'http://127.0.0.1:8080/v1', model: 'qwen' }, blocking: true });
  assert.match(y, /runs-on: ai-local/);
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
  const dir = repo('ssh://acme@ai.local:2222/acme/gmod-demo.git');
  try {
    const r = gmod(dir, ['ci', 'init', '--runs-on', 'ai-local', '--gmod-home', '/g', '--reviewer', 'local', '--review-url', 'http://127.0.0.1:8080/v1', '--owners', '@acme']);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(join(dir, '.gitea/workflows/gmod.yml'), 'utf8'), /runs-on: ai-local/);
    // The plan and the workflow both belong to the owners: a pull request
    // runs its own copy of the workflow, so it could weaken its own gate.
    assert.equal(readFileSync(join(dir, '.gitea/CODEOWNERS'), 'utf8'), '/.gmod/ @acme\n/.gitea/ @acme\n');
    assert.match(r.out, /wrote \.gitea\/workflows\/gmod\.yml/);
    const again = gmod(dir, ['ci', 'init', '--runs-on', 'ai-local', '--gmod-home', '/g']);
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
    gmod(dir, ['ci', 'init', '--runs-on', 'ai-local', '--gmod-home', '/g', '--reviewer', 'local', '--review-url', `${api.url}/v1`]);
    let r = await spawnSyncAsync(dir, ['ci', 'check', '--token-file', join(dir, 'tok')]);
    assert.equal(r.code, 1, 'no runner yet');
    assert.match(r.out, /✅ the workflow is in \.gitea\/workflows\/gmod\.yml/);
    assert.match(r.out, /✅ main requires the gate and up-to-date branches/);
    assert.match(r.out, /✅ the reviewer answers at/);
    assert.match(r.out, /❌ no runner with the label ai-local/);
    state.runners = [{ name: 'box', status: 'online', labels: [{ name: 'ai-local' }] }];
    r = await spawnSyncAsync(dir, ['ci', 'check', '--token-file', join(dir, 'tok')]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✅ runner box \(online\) has the label ai-local/);
    // A runner registered for the whole instance counts too.
    state.runners = [];
    state.instanceRunners = [{ name: 'shared', status: 'online', labels: [{ name: 'ai-local' }] }];
    r = await spawnSyncAsync(dir, ['ci', 'check', '--token-file', join(dir, 'tok')]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✅ runner shared \(online\) has the label ai-local \(the instance's\)/);
    // A token without read:admin can't see those: say so, don't say there is none.
    state.notAdmin = true;
    r = await spawnSyncAsync(dir, ['ci', 'check', '--token-file', join(dir, 'tok')]);
    assert.match(r.out, /❌ no runner with the label ai-local in .*; the instance's runners need a token with read:admin/);
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
    // origin is ssh, as on ai.local; a stand-in ssh runs git on a local bare repository.
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
  const y = workflow({ forge: 'gitea', runsOn: 'ai-local', gmod: { path: '/g' }, reviewer: { kind: 'local', url: 'http://m/v1' }, blocking: true });
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
  const y = workflow({ forge: 'gitea', runsOn: 'ai-local', gmod: { path: '/g' }, reviewer: { kind: 'local', url: 'http://m/v1' }, setup: 'uv sync --frozen\nnpm --prefix web ci' });
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

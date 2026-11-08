// After a landing, CI's own token catches open job branches up. GitHub holds
// the pull_request runs that push starts (actor github-actions[bot]) for a
// person to approve, so gmod starts the gate itself with a repository_dispatch
// naming the branch's new head, and never twice for the same head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AFTER_MERGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ci', 'after-merge.mjs');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-catch-up-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify({ main: 'main', checks: {}, jobs: [] }));
  g('add', '-A'); g('commit', '-q', '-m', 'plan');
  return { dir, landed: g('rev-parse', 'HEAD') };
}

// A fake GitHub: one open job branch, #8 at h8, behind main. Taking main in
// moves it to h8b a moment later (GitHub does it after answering 202).
// `gateOnNew` is what the new head's statuses already say.
async function afterMerge({ gateOnNew = [], updater = '', headAfterUpdate = ['h8', 'h8b'] } = {}) {
  const { dir, landed } = repo();
  const seen = [];
  let updated = false;
  let looks = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const base = '/repos/acme/app';
      const pr8 = sha => ({ number: 8, state: 'open', updated_at: new Date().toISOString(), head: { ref: 'gmod/behind', sha, repo: { full_name: 'acme/app' } }, base: { ref: 'main' } });
      if (req.url.startsWith(`${base}/pulls?state=open`)) return send(200, [pr8('h8')]);
      if (req.url === `${base}/compare/main...h8`) return send(200, { behind_by: 1 });
      if (req.url === `${base}/compare/main...h8b`) return send(200, { behind_by: 0 });
      if (req.url === `${base}/pulls/8/update-branch` && req.method === 'PUT') { updated = true; return send(202, { message: 'Updating pull request branch.' }); }
      if (req.url === `${base}/pulls/8` && req.method === 'GET') {
        const sha = updated ? headAfterUpdate[Math.min(looks++, headAfterUpdate.length - 1)] : 'h8';
        return send(200, pr8(sha));
      }
      if (req.url === `${base}/commits/h8/status`) return send(200, { statuses: [] });
      if (req.url === `${base}/commits/h8b/status`) return send(200, { statuses: gateOnNew });
      if (req.url.startsWith(`${base}/statuses/`) && req.method === 'POST') return send(201, {});
      if (req.url === `${base}/dispatches` && req.method === 'POST') { res.writeHead(204); return res.end(); }
      if (req.url.startsWith(`${base}/issues?state=open`)) return send(200, []);
      send(404, {});
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await new Promise(ok => {
      const p = spawn('node', [AFTER_MERGE], {
        cwd: dir,
        env: { ...process.env, GMOD_FORGE: 'github', GITHUB_API_URL: url, GITHUB_SERVER_URL: '', GITHUB_REPOSITORY: 'acme/app', GMOD_TOKEN: 't', GMOD_SHA: landed, GMOD_FORGE_TOKEN: updater, GITHUB_EVENT_NAME: 'repository_dispatch', GMOD_CATCH_UP_WAIT_MS: '10' },
      });
      let out = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (out += d));
      p.on('close', code => ok({ code, out }));
    });
    return { ...r, seen };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a catch-up starts the gate for the branch\'s new head through a dispatch, not the bot\'s push', async () => {
  const { code, out, seen } = await afterMerge();
  assert.equal(code, 0, out);
  assert.ok(seen.some(x => x.method === 'PUT' && x.url.endsWith('/pulls/8/update-branch') && x.body.expected_head_sha === 'h8'), out);
  const dispatches = seen.filter(x => x.url.endsWith('/dispatches'));
  assert.equal(dispatches.length, 1, out);
  assert.deepEqual(dispatches[0].body, { event_type: 'gmod', client_payload: { check: 8, head: 'h8b' } }, 'the dispatch names the pull request and the head it is to check');
  // The new head shows its gate as on its way, before the run is asked for.
  const st = seen.findIndex(x => x.method === 'POST' && x.url.endsWith('/statuses/h8b'));
  assert.ok(st >= 0, out);
  assert.equal(seen[st].body.context, 'gmod / gate');
  assert.equal(seen[st].body.state, 'pending');
  assert.ok(st < seen.indexOf(dispatches[0]), 'pending is reported before the run is started');
  assert.match(out, /#8 \(gmod\/behind\) takes main in; its checks are started again/);
});

test('a branch is not checked twice for the same commit', async () => {
  for (const state of ['pending', 'success', 'failure']) {
    const { code, out, seen } = await afterMerge({ gateOnNew: [{ context: 'gmod / gate', state }], headAfterUpdate: ['h8b'] });
    assert.equal(code, 0, out);
    assert.ok(!seen.some(x => x.url.endsWith('/dispatches')), `a gate already ${state} on h8b: no second run (${out})`);
    assert.ok(!seen.some(x => x.method === 'POST' && x.url.includes('/statuses/')), out);
    assert.match(out, /#8 \(gmod\/behind\) takes main in; h8b is already checked/);
  }
});

test('with a token whose pushes start runs (a person\'s, or the App\'s), no dispatch', async () => {
  const { code, out, seen } = await afterMerge({ updater: 'app-token' });
  assert.equal(code, 0, out);
  const up = seen.find(x => x.url.endsWith('/pulls/8/update-branch'));
  assert.equal(up.auth, 'Bearer app-token');
  assert.ok(!seen.some(x => x.url.endsWith('/dispatches')), out);
  assert.ok(!seen.some(x => x.url.includes('/statuses/')), out);
  assert.match(out, /its checks run again/);
});

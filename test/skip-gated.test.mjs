// GitHub holds the pull_request run that CI's own push starts (actor
// github-actions[bot]) as action_required; gmod gates that head with a
// dispatch instead. When someone approves the held run anyway, it must not
// gate, review and land the same commit a second time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTION = join(dirname(fileURLToPath(import.meta.url)), '..', 'ci', 'action.mjs');
const RUN = '/acme/app/actions/runs/';

// A repository with an origin holding #8's head at refs/pull/8/head, and a
// fake gmod (GMOD_HOME) whose verify records that it ran.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-skip-gated-'));
  const work = join(dir, 'work');
  const origin = join(dir, 'origin.git');
  const g = (...a) => execFileSync('git', ['-C', work, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
  writeFileSync(join(work, 'a.txt'), 'a\n');
  g('add', '-A'); g('commit', '-q', '-m', 'a');
  g('remote', 'add', 'origin', origin);
  g('push', '-q', 'origin', 'HEAD:refs/pull/8/head');
  const sha = g('rev-parse', 'HEAD');
  const home = join(dir, 'home');
  mkdirSync(join(home, 'bin'), { recursive: true });
  mkdirSync(join(home, 'ci'), { recursive: true });
  const ran = join(dir, 'ran');
  writeFileSync(join(home, 'bin', 'gmod.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(ran)}, process.argv.slice(2).join(' ') + '\\n');`);
  writeFileSync(join(home, 'ci', 'comment.mjs'), '');
  return { dir, work, home, ran, sha };
}

async function action({ event, gate = [], head } = {}) {
  const { dir, work, home, ran, sha } = setup();
  const seen = [];
  const pr8 = { number: 8, state: 'open', title: 't', draft: false, labels: [], head: { ref: 'feature', sha, repo: { full_name: 'acme/app' } }, base: { ref: 'main', sha } };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const base = '/repos/acme/app';
      if (req.url === `${base}/commits/${sha}/status`) return send(200, { state: 'pending', statuses: gate });
      if (req.url === `${base}/pulls/8` && req.method === 'GET') return send(200, pr8);
      if (req.url === `${base}/compare/main...${sha}`) return send(200, { behind_by: 0 });
      if (req.url === `${base}/statuses/${sha}` && req.method === 'POST') return send(201, {});
      send(404, {});
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  const eventPath = join(dir, 'event.json');
  const summary = join(dir, 'summary.md');
  writeFileSync(eventPath, JSON.stringify(event === 'pull_request'
    ? { action: 'synchronize', pull_request: pr8 }
    : { action: 'gmod', client_payload: head ? { check: 8, head: head === true ? sha : head } : { check: 8 } }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GMOD_|GITHUB_|ANTHROPIC_)/.test(k)) delete env[k];
  try {
    const r = await new Promise(ok => {
      const p = spawn('node', [ACTION], {
        cwd: work,
        env: {
          ...env, GMOD_HOME: home, GMOD_GITHUB_TOKEN: 't', GMOD_FORGE: 'github', GITHUB_API_URL: url, GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '200', GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summary,
        },
      });
      let out = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (out += d));
      p.on('close', code => ok({ code, out }));
    });
    return {
      ...r, seen, sha,
      gated: existsSync(ran) && readFileSync(ran, 'utf8').includes('verify'),
      summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
    };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const reported = seen => seen.filter(x => x.method === 'POST' && x.url.includes('/statuses/'));

test('a head whose gmod/gate status already exists is not gated again', async () => {
  // The held bot run, approved after gmod's dispatched run took (or finished) the head.
  for (const state of ['pending', 'success', 'failure']) {
    const { code, out, seen, gated, summary } = await action({
      event: 'pull_request',
      gate: [{ context: 'gmod / gate', state, target_url: `https://github.com${RUN}100` }],
    });
    assert.equal(code, 0, out);
    assert.equal(gated, false, `gate already ${state}: not run again (${out})`);
    assert.deepEqual(reported(seen), [], 'no status is touched');
    assert.ok(!seen.some(x => x.method === 'PUT'), 'nothing lands');
    assert.match(summary, /already/i, 'the summary says why nothing ran');
    assert.match(out, /already/i);
  }
  // after-merge's marker (pending, no run yet): the dispatched run owns this head.
  const { gated, summary } = await action({ event: 'pull_request', gate: [{ context: 'gmod / gate', state: 'pending', description: 'caught up with main; the gate run is starting' }] });
  assert.equal(gated, false);
  assert.match(summary, /already/i);
});

test('a head with no gate status is gated as before', async () => {
  const { code, out, seen, gated, sha } = await action({ event: 'pull_request', gate: [{ context: 'gmod / review', state: 'success' }] });
  assert.equal(code, 0, out);
  assert.equal(gated, true, out);
  const st = reported(seen);
  assert.deepEqual(st.map(x => [x.url, x.body.context, x.body.state]), [[`/repos/acme/app/statuses/${sha}`, 'gmod / gate', 'pending'], [`/repos/acme/app/statuses/${sha}`, 'gmod / gate', 'success']]);
});

test('the dispatched run gates the head after-merge marked pending for it', async () => {
  const marker = [{ context: 'gmod / gate', state: 'pending', description: 'caught up with main; the gate run is starting' }];
  const r = await action({ event: 'repository_dispatch', head: true, gate: marker });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.gated, true, r.out);
  // A dispatch without that head (or for another head) doesn't own the marker.
  const other = await action({ event: 'repository_dispatch', gate: marker });
  assert.equal(other.gated, false, other.out);
});

test('a person re-running the run that gated the head gates it again', async () => {
  const { code, out, gated } = await action({ event: 'pull_request', gate: [{ context: 'gmod / gate', state: 'failure', target_url: `https://github.com${RUN}200` }] });
  assert.equal(code, 0, out);
  assert.equal(gated, true, out);
});

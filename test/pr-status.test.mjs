// gmod pr --status on GitHub: the pull request, its checks and the gate's and
// review's reports, read through gh. No network: origin is
// git@github.com:o/r.git (only read, never fetched), and gh is a fake
// (GMOD_GH) that answers `gh pr view` from a recorded reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// What `gh pr view gmod/fix --json number,url,state,statusCheckRollup,comments`
// answers for a pull request whose gate failed and whose review passed, with
// an earlier run of the gate still in the rollup.
const RECORDED = {
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'gate', workflowName: 'gmod', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z' },
    { __typename: 'CheckRun', name: 'gmod', workflowName: 'gmod', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:05:00Z' },
    { __typename: 'CheckRun', name: 'gate', workflowName: 'gmod', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-01T10:06:00Z' },
    { __typename: 'CheckRun', name: 'review', workflowName: 'gmod', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:07:00Z' },
    { __typename: 'CheckRun', name: 'land', workflowName: 'gmod', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-11-01T10:08:00Z' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' },
  ],
  comments: [
    { author: { login: 'someone' }, body: 'looks fine to me' },
    { author: { login: 'github-actions' }, body: '<!-- gmod-gate -->\n## gate\nfix failed: test/x.test.mjs' },
    { author: { login: 'github-actions' }, body: '<!-- gmod-review -->\n## review\nnothing weakened' },
  ],
};

let tmp, work, log;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmod-pr-status-'));
  log = join(tmp, 'gh.log');
  const fake = join(tmp, 'fake-gh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view' && a[2] === 'gmod/fix') { process.stdout.write(${JSON.stringify(JSON.stringify(RECORDED))}); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') { process.stderr.write('no pull requests found for branch "' + a[2] + '"'); process.exit(1); }
process.stderr.write('fake gh: no reply for ' + a.join(' '));
process.exit(1);
`);
  chmodSync(fake, 0o755);
  work = join(tmp, 'work');
  run('git', ['init', '-q', '-b', 'main', work]);
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'seed'], work);
  run('git', ['checkout', '-q', '-b', 'gmod/fix'], work);
  run('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], work);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const gmod = (...args) => spawnSync('node', [GMOD, ...args], {
  cwd: work,
  encoding: 'utf8',
  env: { ...process.env, GMOD_GH: join(tmp, 'fake-gh.mjs'), GITEA_TOKEN: '' },
});

test('pr --status on GitHub reports the checks and both reports from gh', () => {
  writeFileSync(log, '');
  const r = gmod('pr', '--status', '--json');
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.number, 7);
  assert.equal(s.url, 'https://github.com/o/r/pull/7');
  assert.equal(s.state, 'open');
  const by = Object.fromEntries(s.checks.map(c => [c.context, c.state]));
  assert.equal(by['gmod / gmod'] ?? by.gmod, 'success');
  assert.equal(by['gmod / gate'], 'failure', 'the latest run of a check counts');
  assert.equal(by['gmod / review'], 'success');
  assert.equal(by['gmod / land'], 'pending');
  assert.equal(by['ci/legacy'], 'pending');
  assert.equal(s.checks.filter(c => c.context === 'gmod / gate').length, 1);
  assert.deepEqual(s.reports, ['## gate\nfix failed: test/x.test.mjs', '## review\nnothing weakened']);
  assert.equal(s.note, null);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(calls.some(a => a[0] === 'pr' && a[1] === 'view' && a[2] === 'gmod/fix' && a.includes('--repo') && a.includes('o/r')), JSON.stringify(calls));

  const text = gmod('pr', '--status');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^#7 open: https:\/\/github\.com\/o\/r\/pull\/7$/m);
  assert.match(text.stdout, /❌ gmod \/ gate: failure/);
  assert.match(text.stdout, /✅ gmod \/ review: success/);
  assert.match(text.stdout, /fix failed: test\/x\.test\.mjs/);
  assert.match(text.stdout, /nothing weakened/);
});

test('pr --status on GitHub says when the branch has no pull request', () => {
  const r = gmod('pr', '--status', '--branch', 'gmod/none');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /no pull request from gmod\/none/);
});

// gmod setup's pieces that need no forge: the workflow it writes, and which
// release is newest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionWorkflow, latestOf, newer, reviewerSecret } from '../lib/setup.mjs';

test('the workflow is the pinned action, with the reviewer chosen', () => {
  const w = actionWorkflow({ ref: 'v0.2.0', reviewer: { kind: 'openai', url: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } });
  assert.match(w, /^ {6}- uses: soundheart-studios\/gmod@v0\.2\.0$/m);
  assert.match(w, /reviewer-url: https:\/\/api\.deepseek\.com\/v1\n {10}reviewer-model: deepseek-flash\n {10}reviewer-key: \$\{\{ secrets\.GMOD_REVIEW_KEY \}\}/);
  assert.match(w, /repository_dispatch: \{ types: \[gmod\] \}/, 'gmod can start its own follow-up runs');
  assert.match(w, /permissions: \{ contents: write, pull-requests: write, issues: write, statuses: write \}/);
  assert.doesNotMatch(w, /blocking/, 'blocking is the default');
  const claude = actionWorkflow({ ref: 'v0.2.0' });
  assert.match(claude, /reviewer-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.doesNotMatch(claude, /reviewer-url/);
  const plain = actionWorkflow({ ref: 'v0.2.0', reviewer: { kind: 'none' }, setup: 'npm ci' });
  assert.doesNotMatch(plain, /reviewer/);
  assert.match(plain, /setup: "npm ci"/);
  assert.match(actionWorkflow({ ref: 'v0.2.0', blocking: false }), /blocking: 'false'/);
  assert.equal(reviewerSecret({ kind: 'claude' }), 'ANTHROPIC_API_KEY');
  assert.equal(reviewerSecret({ kind: 'openai' }), 'GMOD_REVIEW_KEY');
  assert.equal(reviewerSecret({ kind: 'none' }), null);
});

test('the newest release, and release candidates only when asked for', () => {
  assert.equal(newer('v0.2.0', 'v0.2.0-rc.2'), true, 'a release beats its candidates');
  assert.equal(newer('v0.2.0-rc.2', 'v0.2.0-rc.1'), true);
  assert.equal(newer('v0.10.0', 'v0.9.3'), true, 'numbers, not text');
  assert.equal(newer('v0.2.0', 'v0.2.0'), false);
  assert.equal(newer('next', 'v0.2.0'), false, 'a branch is not a release');
  const tags = ['v0.1.0', 'v0.2.0-rc.1', 'v0.2.0-rc.2', 'before-gaps', 'v0.10.0-rc.1'];
  assert.equal(latestOf(tags), 'v0.1.0');
  assert.equal(latestOf(tags, { candidates: true }), 'v0.10.0-rc.1');
  assert.equal(latestOf(['before-gaps']), null);
});

test('on Gitea: the action from the Gitea copy of gmod, on its runner, with the person\'s token', async () => {
  const { actionWorkflow, reviewerSecret } = await import('../lib/setup.mjs');
  const y = actionWorkflow({ forge: 'gitea', action: 'acme/gmod', ref: 'v1.0.0', runsOn: 'ai-local-docker', reviewer: { kind: 'openai', url: 'http://127.0.0.1:8080/v1' } });
  assert.match(y, /repository: acme\/gmod, ref: v1\.0\.0, path: \.gmod-tool, token: \$\{\{ secrets\.GMOD_FORGE_TOKEN \}\}/);
  assert.match(y, /uses: \.\/\.gmod-tool\n/);
  assert.match(y, /checkout: 'false'/);
  assert.match(y, /runs-on: ai-local-docker/);
  assert.match(y, /forge-token: \$\{\{ secrets\.GMOD_FORGE_TOKEN \}\}/);
  assert.doesNotMatch(y, /repository_dispatch|permissions:/, 'GitHub only');
  assert.doesNotMatch(y, /reviewer-key/, 'a model on the runner itself needs no key');
  assert.equal(reviewerSecret({ kind: 'openai', url: 'http://127.0.0.1:8080/v1' }), null);
  assert.equal(reviewerSecret({ kind: 'openai', url: 'https://api.deepseek.com/v1' }), 'GMOD_REVIEW_KEY');
  const gh = actionWorkflow({ ref: 'v1.0.0', reviewer: { kind: 'none' } });
  assert.match(gh, /repository_dispatch/);
  assert.match(gh, /runs-on: ubuntu-latest/);
});

test('gmod runner up: config into a volume, then the official runner, the token only in its environment', async () => {
  const { runnerCommands, runnerName, RUNNER_IMAGE } = await import('../lib/runner.mjs');
  assert.equal(runnerName({ owner: 'acme', repo: 'gmod-test-gt' }), 'gmod-acme-gmod-test-gt');
  const [vol, config, run] = runnerCommands({ name: 'gmod-a-b', instance: 'http://ai.local:3000', labels: ['gmod:docker://node:22-bookworm'], capacity: 3 });
  assert.deepEqual(vol, ['volume', 'create', 'gmod-a-b-data']);
  assert.match(config.at(-1), /config set runner\.capacity 3/);
  assert.match(config.at(-1), /config set container\.network host/);
  assert.ok(run.includes('GITEA_RUNNER_LABELS=gmod:docker://node:22-bookworm'));
  assert.ok(run.includes('GITEA_INSTANCE_URL=http://ai.local:3000'));
  assert.ok(run.includes('GITEA_RUNNER_REGISTRATION_TOKEN'), 'passed by name: docker reads it from its environment');
  assert.ok(!run.some(a => /GITEA_RUNNER_REGISTRATION_TOKEN=/.test(a)), 'never on the command line');
  assert.equal(run.at(-1), RUNNER_IMAGE);
  assert.ok(run.includes('--restart') && run.includes('unless-stopped'));
});

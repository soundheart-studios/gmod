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

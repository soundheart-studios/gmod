// The reviewer against a stand-in model: it fails closed when it blocks, an
// empty diff is never a verdict, and a governance change gets its own question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), '..', 'ci', 'review.mjs');
const PLAN = { main: 'main', checks: { ok: 'true' }, jobs: [{ id: 'add-sum', goal: 'Add', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'adds', check: 'ok' }] }] };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-review-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN));
  g('add', '-A'); g('commit', '-q', '-m', 'seed');
  return { dir, g, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// A model behind an OpenAI-compatible API: answers what `reply` says.
async function model(reply) {
  const asked = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      asked.push(b);
      const r = reply(b);
      if (r.status) { res.writeHead(r.status); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'stand-in', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(r) } }] }));
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { asked, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

function review(cwd, env, ...args) {
  return new Promise(ok => {
    const p = spawn('node', [REVIEW, '--base', 'main', '--head', 'HEAD', ...args], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '', GMOD_REVIEW_MODE: '', ...env } });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (out += d));
    p.on('close', code => ok({ code, out }));
  });
}

test('an empty diff is never a verdict: blocking, it stops the merge', async () => {
  const r0 = repo();
  const m = await model(() => ({ status: 500 }));
  try {
    const r = await review(r0.dir, { GMOD_REVIEW_URL: m.url }, '--branch', 'gmod/add-sum');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /nothing to review/);
    assert.equal(m.asked.length, 0, 'the model is not asked about nothing');
    const advice = await review(r0.dir, { GMOD_REVIEW_URL: m.url, GMOD_REVIEW_MODE: 'comment' }, '--branch', 'gmod/add-sum');
    assert.equal(advice.code, 0);
  } finally { m.close(); r0.done(); }
});

test('a reviewer that cannot answer stops a blocking review', async () => {
  const r0 = repo();
  const m = await model(() => ({ status: 500 }));
  try {
    r0.g('switch', '-q', '-c', 'gmod/add-sum');
    mkdirSync(join(r0.dir, 'src'));
    writeFileSync(join(r0.dir, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
    r0.g('add', '-A'); r0.g('commit', '-q', '-m', 'add-sum: adds');
    const r = await review(r0.dir, { GMOD_REVIEW_URL: m.url }, '--branch', 'gmod/add-sum');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /answered 500; run it again/);
  } finally { m.close(); r0.done(); }
});

test('a governance change is asked whether it weakens what is checked', async () => {
  const r0 = repo();
  const m = await model(b => (b.messages[0].content.includes('governance')
    ? { summary: 'Makes the review advice only.', weakens: { verdict: 'fail', evidence: '+  GMOD_REVIEW_MODE: comment' }, overall: 'fail' }
    : { status: 500 }));
  try {
    r0.g('switch', '-q', '-c', 'gmod/ci-tweak');
    mkdirSync(join(r0.dir, '.gitea', 'workflows'), { recursive: true });
    writeFileSync(join(r0.dir, '.gitea', 'workflows', 'gmod.yml'), 'env:\n  GMOD_REVIEW_MODE: comment\n');
    r0.g('add', '-A'); r0.g('commit', '-q', '-m', 'ci: quieter review');
    const r = await review(r0.dir, { GMOD_REVIEW_URL: m.url }, '--branch', 'gmod/ci-tweak');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /### gmod review: fail \(a governance change\)/);
    assert.match(r.out, /❌ \*\*Weakens what is checked:\*\* \+  GMOD_REVIEW_MODE: comment/);
    assert.equal(m.asked[0].response_format.json_schema.schema.required.join(','), 'summary,weakens,overall');
    // The label a maintainer adds turns the fail into a note.
    const over = await review(r0.dir, { GMOD_REVIEW_URL: m.url, GMOD_REVIEW_OVERRIDE: '1' }, '--branch', 'gmod/ci-tweak');
    assert.equal(over.code, 0, over.out);
    assert.match(over.out, /Overridden by a maintainer/);
  } finally { m.close(); r0.done(); }
});

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
      if (r.status) { res.writeHead(r.status); return res.end(r.body ?? '{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (r.cutOff) return res.end(JSON.stringify({ model: 'stand-in', choices: [{ finish_reason: 'length', message: { content: '{"summary": "Adds' } }] }));
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
    assert.match(r.out, /answered 500.*run it again/);
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

test('a managed-mode switch alone is a governance change', async () => {
  const r0 = repo();
  const m = await model(b => (b.messages[0].content.includes('governance')
    ? { summary: 'Turns managed mode on.', weakens: { verdict: 'pass', evidence: '+{ "v": 1, "managed": true }' }, overall: 'pass' }
    : { status: 500 }));
  try {
    r0.g('switch', '-q', '-c', 'gmod/managed');
    writeFileSync(join(r0.dir, '.gmod', 'managed.json'), '{ "v": 1, "managed": true }\n');
    r0.g('add', '-A'); r0.g('commit', '-q', '-m', 'managed: on');
    const r = await review(r0.dir, { GMOD_REVIEW_URL: m.url }, '--branch', 'gmod/managed');
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /no job named/);
    assert.match(r.out, /### gmod review: pass \(a governance change\)/);
    assert.equal(m.asked.length, 1, 'asked the governance question once');
    assert.match(m.asked[0].messages[1].content, /managed\.json/);
  } finally { m.close(); r0.done(); }
});

test('a reviewer API without JSON schemas is asked in plain JSON mode', async () => {
  const r0 = repo();
  const pass = { verdict: 'pass', evidence: 'src/sum.mjs:1' };
  const answer = { summary: 'Adds sum.', criteria: [{ criterion: 'adds', ...pass }], tests_are_real: pass, stays_within_goal: pass, adrs: [], overall: 'pass' };
  // Like DeepSeek: json_schema is refused, json_object is fine.
  const m = await model(b => (b.response_format.type === 'json_schema'
    ? { status: 400, body: '{"error":{"message":"This response_format type is unavailable now"}}' }
    : answer));
  try {
    r0.g('switch', '-q', '-c', 'gmod/add-sum');
    mkdirSync(join(r0.dir, 'src'));
    writeFileSync(join(r0.dir, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
    r0.g('add', '-A'); r0.g('commit', '-q', '-m', 'add-sum: adds');
    const r = await review(r0.dir, { GMOD_REVIEW_URL: m.url, GMOD_REVIEW_MODEL: 'deepseek-flash' }, '--branch', 'gmod/add-sum');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /### gmod review: pass/);
    assert.deepEqual(m.asked.map(b => b.response_format.type), ['json_schema', 'json_object']);
    assert.match(r.out, /A fail stops the merge/, 'a blocking review says it blocks');
    assert.match(m.asked[1].messages[0].content, /matching this JSON schema/);
    assert.equal(m.asked[1].model, 'deepseek-flash');
  } finally { m.close(); r0.done(); }
});

test('a reviewer cut off by its token limit is asked once more with twice the room', async () => {
  const r0 = repo();
  const pass = { verdict: 'pass', evidence: 'src/sum.mjs:1' };
  const answer = { summary: 'Adds sum.', criteria: [{ criterion: 'adds', ...pass }], tests_are_real: pass, stays_within_goal: pass, adrs: [], overall: 'pass' };
  // Like a thinking model: its reasoning spends the first limit.
  const m = await model(b => (b.max_tokens < 32000 ? { cutOff: true } : answer));
  try {
    r0.g('switch', '-q', '-c', 'gmod/add-sum');
    mkdirSync(join(r0.dir, 'src'));
    writeFileSync(join(r0.dir, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
    r0.g('add', '-A'); r0.g('commit', '-q', '-m', 'add-sum: adds');
    const r = await review(r0.dir, { GMOD_REVIEW_URL: m.url }, '--branch', 'gmod/add-sum');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /### gmod review: pass/);
    assert.deepEqual(m.asked.map(b => b.max_tokens), [16000, 32000]);
    // The limit is the repository's to set; an answer still cut off says why.
    const set = await review(r0.dir, { GMOD_REVIEW_URL: m.url, GMOD_REVIEW_MAX_TOKENS: '4000' }, '--branch', 'gmod/add-sum');
    assert.equal(set.code, 1, set.out);
    assert.match(set.out, /stopped: length/);
    // Each ask doubles once and no further.
    const later = m.asked.slice(2).map(b => b.max_tokens);
    assert.ok(later.length >= 2 && later.every((t, i) => t === (i % 2 ? 8000 : 4000)), later.join(','));
  } finally { m.close(); r0.done(); }
});

test('generated files reach the reviewer as a sample, not whole', async () => {
  const r0 = repo();
  const pass = { verdict: 'pass', evidence: 'src/sum.mjs:1' };
  const m = await model(() => ({ summary: 'Adds sum.', criteria: [{ criterion: 'adds', ...pass }], tests_are_real: pass, stays_within_goal: pass, adrs: [], overall: 'pass' }));
  try {
    r0.g('switch', '-q', '-c', 'gmod/add-sum');
    mkdirSync(join(r0.dir, 'src'));
    mkdirSync(join(r0.dir, 'config', 'crd'), { recursive: true });
    writeFileSync(join(r0.dir, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
    const crd = ['---', 'apiVersion: apiextensions.k8s.io/v1', 'kind: CustomResourceDefinition', 'metadata:', '  annotations:', '    controller-gen.kubebuilder.io/version: v0.23.0',
      ...Array.from({ length: 3000 }, (_, i) => `      field${i}: {type: string, description: "a long generated description number ${i}"}`)].join('\n');
    writeFileSync(join(r0.dir, 'config', 'crd', 'things.yaml'), crd + '\n');
    writeFileSync(join(r0.dir, 'src', 'zz_generated.deepcopy.go'), '// Code generated by controller-gen. DO NOT EDIT.\n' + Array.from({ length: 2000 }, (_, i) => `func f${i}() {}`).join('\n') + '\n');
    r0.g('add', '-A'); r0.g('commit', '-q', '-m', 'add-sum: adds');
    const r = await review(r0.dir, { GMOD_REVIEW_URL: m.url }, '--branch', 'gmod/add-sum');
    assert.equal(r.code, 0, r.out);
    const sent = m.asked[0].messages[1].content;
    assert.match(sent, /export const sum/, 'code is sent whole');
    assert.match(sent, /generated file, shortened: 3006 lines added/);
    assert.match(sent, /generated file, shortened: 2001 lines added/);
    assert.ok(!sent.includes('field2999') && !sent.includes('f1999()'), 'the rest of the generated files is not sent');
    assert.match(r.out, /Shortened for the reviewer: .*config\/crd\/things\.yaml/);
  } finally { m.close(); r0.done(); }
});

test('recorded data reaches the reviewer as a sample, not whole', async () => {
  const r0 = repo();
  const pass = { verdict: 'pass', evidence: 'src/sum.mjs:1' };
  const m = await model(() => ({ summary: 'Adds sum.', criteria: [{ criterion: 'adds', ...pass }], tests_are_real: pass, stays_within_goal: pass, adrs: [], overall: 'pass' }));
  try {
    r0.g('switch', '-q', '-c', 'gmod/add-sum');
    mkdirSync(join(r0.dir, 'src', 'days'), { recursive: true });
    writeFileSync(join(r0.dir, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
    writeFileSync(join(r0.dir, 'src', 'days', 'AAPL.jsonl'), Array.from({ length: 5000 }, (_, i) => JSON.stringify({ t: i, c: '187.12' })).join('\n') + '\n');
    r0.g('add', '-A'); r0.g('commit', '-q', '-m', 'add-sum: adds');
    const r = await review(r0.dir, { GMOD_REVIEW_URL: m.url }, '--branch', 'gmod/add-sum');
    assert.equal(r.code, 0, r.out);
    const sent = m.asked[0].messages[1].content;
    assert.match(sent, /export const sum/, 'code is sent whole');
    assert.match(sent, /data file, shortened: 5000 lines added/);
    assert.ok(!sent.includes('"t":4999'), 'the rest of the data is not sent');
    assert.ok(sent.length < 20_000, `sent ${sent.length} characters`);
    assert.match(r.out, /Shortened for the reviewer: src\/days\/AAPL\.jsonl/);
  } finally { m.close(); r0.done(); }
});

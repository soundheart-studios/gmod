// `gmod mcp`: the agent's tools as a stdio MCP server (lib/mcp.mjs), for
// hosts other than Claude Code. Driven over newline-delimited JSON-RPC against
// throwaway repositories, and held to the list the mod registers
// (hooks/register.tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { TOOLS } from '../lib/mcp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GMOD = join(HERE, '..', 'bin', 'gmod.mjs');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const k of Object.keys(ENV)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/.test(k)) delete ENV[k];
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();

const PLAN = {
  main: 'main',
  checks: { built: 'test -f src/one.mjs' },
  jobs: [{ id: 'one', goal: 'Build one', files: ['src/one.mjs'], done_when: [{ text: 'one is built', check: 'built' }] }],
};

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-mcp-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const dir = join(top, 'alice');
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed the plan']);
  sh(dir, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  const elsewhere = join(top, 'elsewhere');
  mkdirSync(elsewhere);
  return { top, dir, elsewhere, done: () => rmSync(top, { recursive: true, force: true }) };
}

// One server; send() resolves with the reply to that id. Every stdout line
// must be a JSON-RPC message.
function server(cwd) {
  const p = spawn('node', [GMOD, 'mcp'], { cwd, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  const stray = [];
  createInterface({ input: p.stdout }).on('line', line => {
    const m = JSON.parse(line);
    assert.equal(m.jsonrpc, '2.0', line);
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    } else stray.push(m);
  });
  let n = 0;
  const send = (method, params) => new Promise(res => {
    const id = ++n;
    waiting.set(id, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  const call = async (name, args = {}) => (await send('tools/call', { name, arguments: args })).result;
  const close = () => new Promise(res => { p.on('close', res); p.stdin.end(); });
  return { send, notify, call, close, stray };
}

const textOf = r => r.content.map(c => c.text).join('\n');

// The mod's own registrations, read from its source.
const REGISTER = readFileSync(join(HERE, '..', 'hooks', 'register.tsx'), 'utf8');
const MOD = [...REGISTER.matchAll(/\$\.tool\.register\(\{ name: '([^']+)'(.*)$/gm)].map(([, name, rest]) => ({
  name,
  dir: rest.includes('...DIR') || rest.includes('properties: DIR'),
  required: (rest.match(/required: \[([^\]]*)\] \}, isDeferred/)?.[1] ?? '').split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean),
}));

test('the tool list holds every tool the mod registers, by the same name and schema', () => {
  assert.ok(MOD.length >= 17, `read ${MOD.length} tools from hooks/register.tsx`);
  const ours = new Map(TOOLS.map(t => [t.name, t]));
  for (const m of MOD) {
    const t = ours.get(m.name);
    assert.ok(t, `the mod registers ${m.name}; lib/mcp.mjs does not list it`);
    assert.equal(t.inputSchema.type, 'object', m.name);
    assert.deepEqual(t.inputSchema.required ?? [], m.required, `${m.name}: required`);
    assert.equal('dir' in (t.inputSchema.properties ?? {}), m.dir, `${m.name}: dir`);
    assert.ok(t.description, `${m.name}: a description`);
  }
  assert.ok(ours.has('board'), 'board is served too');
  for (const t of TOOLS) assert.ok(t.name === 'board' || MOD.some(m => m.name === t.name), `${t.name} is served but the mod registers no such tool`);
});

test('gmod mcp answers initialize, ping and tools/list', async () => {
  const w = world();
  const s = server(w.dir);
  try {
    const init = await s.send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, 'gmod');
    const { version } = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(init.result.serverInfo.version, version);
    s.notify('notifications/initialized');

    const odd = await s.send('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    assert.equal(odd.result.protocolVersion, '2025-06-18');

    assert.deepEqual((await s.send('ping')).result, {});
    const list = await s.send('tools/list');
    const names = list.result.tools.map(t => t.name);
    for (const m of MOD) assert.ok(names.includes(m.name), `tools/list lacks ${m.name}`);
    assert.ok(names.includes('board'));
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

    const unknown = await s.send('resources/list');
    assert.equal(unknown.error.code, -32601);
    assert.deepEqual(s.stray, [], 'no reply to a notification, nothing else on stdout');
  } finally {
    await s.close();
    w.done();
  }
});

test('tools/call claim, check and status run gmod in the given dir; a refusal is an error result', async () => {
  const w = world();
  // The server runs elsewhere: only dir takes it to the repository.
  const s = server(w.elsewhere);
  try {
    await s.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    s.notify('notifications/initialized');

    const refused = await s.call('claim', { job: 'nope', dir: w.dir });
    assert.equal(refused.isError, true, textOf(refused));
    assert.match(textOf(refused), /nope/);

    const claimed = await s.call('claim', { job: 'one', dir: w.dir });
    assert.ok(!claimed.isError, textOf(claimed));
    assert.match(textOf(claimed), /claimed one/);

    const red = await s.call('check', { dir: w.dir });
    assert.match(textOf(red), /one: red/);
    mkdirSync(join(w.dir, 'src'), { recursive: true });
    writeFileSync(join(w.dir, 'src', 'one.mjs'), 'export const one = 1;\n');
    const green = await s.call('check', { dir: w.dir });
    assert.ok(!green.isError, textOf(green));
    assert.match(textOf(green), /one: green/);

    const st = JSON.parse(textOf(await s.call('status', { dir: w.dir })));
    assert.equal(st.claim.job, 'one');
    assert.equal(st.sawRed, true);

    const board = await s.call('board', { dir: w.dir });
    assert.ok(!board.isError, textOf(board));
    assert.match(textOf(board), /one/);

    // Without dir, the server's own folder: not a repository.
    const lost = await s.call('status');
    assert.ok(!/"claim":\{"job":"one"/.test(textOf(lost)));
  } finally {
    await s.close();
    w.done();
  }
});

test("describe_proposal, propose_job and adr_propose end with the card's text", async () => {
  const w = world();
  const s = server(w.dir);
  try {
    await s.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const proposed = await s.call('propose_job', { job: { id: 'two', goal: 'Build two', files: ['src/two.mjs'], done_when: [{ text: 'two is built', check: 'built' }] } });
    assert.ok(!proposed.isError, textOf(proposed));
    assert.match(textOf(proposed), /Plan change: 1 new job/);

    const described = await s.call('describe_proposal', { summary: 'Add a second piece', assumptions: ['two is small'] });
    assert.ok(!described.isError, textOf(described));
    const text = textOf(described);
    assert.match(text, /Plan change: 1 new job/);
    assert.match(text, /Add a second piece/);
    assert.match(text, /two is small/);
    assert.match(text, /gmod decide \S+ reject\s*$/, 'ends with the card');

    const adr = await s.call('adr_propose', { title: 'Plain text only', scope: ['lib/render.mjs'], decision: 'Render as plain text.', rules: [{ level: 'must', text: 'no ANSI colour codes' }] });
    assert.ok(!adr.isError, textOf(adr));
    assert.match(textOf(adr), /Decision: Plain text only/);
    assert.match(textOf(adr), /gmod decide \S+ reject\s*$/);

    const bad = await s.call('propose_job', { job: { id: 'Bad Id' } });
    assert.equal(bad.isError, true);
  } finally {
    await s.close();
    w.done();
  }
});

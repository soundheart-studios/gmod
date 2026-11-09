// A stuck job's signal can be set aside by the person: they fixed it by hand,
// or know about it. `gmod decide <id> resolve` leaves a shared mark
// (refs/gmod/resolved/<signal-id>) holding the signal's rev; the signal stays
// hidden on every clone while its rev is the same, and comes back when the
// job is red again on a new run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GMOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gmod.mjs');
const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/;
const PERSON = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_VARS.test(k)));
const ENV = { ...PERSON, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
function gmod(cwd, args, env = {}) {
  const r = spawnSync('node', [GMOD, ...args], { cwd, env: { ...ENV, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const ok = (cwd, args, env) => {
  const r = gmod(cwd, args, env);
  assert.equal(r.code, 0, `gmod ${args.join(' ')}: ${r.err}`);
  return r.out;
};
function write(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

const PLAN = {
  main: 'main',
  checks: { sum: 'node test/sum.test.mjs' },
  jobs: [{ id: 'add-sum', goal: 'Add two numbers', files: ['src/**'], tests: ['test/**'], done_when: [{ text: 'sum adds', check: 'sum' }] }],
};
const TEST = "import { sum } from '../src/sum.mjs';\nif (sum(2, 3) !== 5) process.exit(1);\n";

function world() {
  const top = mkdtempSync(join(tmpdir(), 'gmod-resolve-'));
  const origin = join(top, 'origin.git');
  sh(top, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = name => {
    const dir = join(top, name);
    sh(top, 'clone', '-q', origin, dir);
    sh(dir, 'config', 'user.email', `${name}@x.io`);
    sh(dir, 'config', 'user.name', name);
    return dir;
  };
  const seed = clone('owner');
  write(seed, { '.gmod/plan.json': JSON.stringify(PLAN, null, 2), 'src/sum.mjs': 'export const sum = () => 0;\n' });
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'seed the plan');
  sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  return { agent: clone('agent'), person: clone('person'), other: clone('other'), done: () => rmSync(top, { recursive: true, force: true }) };
}

const stuck = dir => JSON.parse(ok(dir, ['signals', '--json'])).signals.find(s => s.cause?.stuck === 'add-sum');

test("resolve hides a stuck job's signal on every clone until it is red again on a new run", () => {
  const w = world();
  try {
    ok(w.agent, ['claim', 'add-sum']);
    write(w.agent, { 'test/sum.test.mjs': TEST });
    gmod(w.agent, ['check']); // red

    const s = stuck(w.person);
    assert.ok(s, 'stuck elsewhere');
    assert.ok(s.rev, 'carries a rev');
    assert.ok(s.actions.includes('resolve'), `offers resolve: ${s.actions}`);

    // Only a person.
    const r = gmod(w.person, ['decide', s.id, 'resolve', '--via', 'skiff'], { CLAUDECODE: '1' });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /only a person decides/);
    assert.ok(stuck(w.person), 'still there');

    const out = JSON.parse(ok(w.person, ['decide', s.id, 'resolve', '--note', 'fixed the fixture by hand', '--via', 'skiff', '--json']));
    assert.equal(out.decided, true);
    assert.equal(stuck(w.person), undefined, 'hidden here');
    assert.equal(stuck(w.other), undefined, 'and on every clone');

    // Red again on a new run: back, under the same id with a new rev.
    gmod(w.agent, ['check']);
    const again = stuck(w.other);
    assert.ok(again, 'a new red run shows it again');
    assert.equal(again.id, s.id);
    assert.notEqual(again.rev, s.rev);
  } finally { w.done(); }
});

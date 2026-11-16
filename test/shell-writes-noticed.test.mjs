// A shell command can write any file; what it wrote can't be read from its
// text, but it can be seen afterwards. With a job claimed, gmod lists the
// changed and new files outside the job (strayFiles) and, after the command,
// tells the agent once which they are and how to put them back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strayFiles } from '../lib/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GMOD = join(HERE, '..', 'bin', 'gmod.mjs');
const FIX = join(HERE, 'fixtures', 'codex');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const k of Object.keys(ENV)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_.*|PI_AGENT|GMOD_AGENT|CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/.test(k)) delete ENV[k];
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const gmod = (cwd, ...args) => sh(cwd, 'node', [GMOD, ...args]);

const PLAN = {
  main: 'main',
  checks: { built: 'test -f notes.txt' },
  jobs: [
    { id: 'one', goal: 'Write notes', files: ['notes.txt'], tests: ['test/notes.test.mjs'], done_when: [{ text: 'notes are written', check: 'built' }] },
  ],
};

function world({ claim = true } = {}) {
  const top = mkdtempSync(join(tmpdir(), 'gmod-strays-'));
  const origin = join(top, 'origin.git');
  sh(top, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const dir = join(top, 'repo');
  sh(top, 'git', ['clone', '-q', origin, dir]);
  sh(dir, 'git', ['config', 'user.email', 'alice@x.io']);
  sh(dir, 'git', ['config', 'user.name', 'alice']);
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify(PLAN, null, 2) + '\n');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  writeFileSync(join(dir, 'other.txt'), 'other\n');
  writeFileSync(join(dir, '.gitignore'), 'build/\n*.log\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed']);
  sh(dir, 'git', ['push', '-q', 'origin', 'HEAD:main']);
  if (claim) gmod(dir, 'claim', 'one');
  return { top, dir, done: () => rmSync(top, { recursive: true, force: true }) };
}

const postBash = (dir, command) => ({ ...JSON.parse(readFileSync(join(FIX, 'post-bash.json'), 'utf8').replaceAll('/REPO', dir)), tool_input: { command } });

function hook(input, cwd) {
  const r = spawnSync('node', [GMOD, 'hook', 'codex'], { cwd, env: ENV, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function context(out) {
  assert.ok(out.trim(), 'the hook said something');
  const o = JSON.parse(out);
  assert.equal(o.hookSpecificOutput.hookEventName, 'PostToolUse');
  return o.hookSpecificOutput.additionalContext;
}

test('strayFiles lists changed and new files outside the job, its tests and its journal', () => {
  const w = world();
  try {
    assert.deepEqual(strayFiles(w.dir), [], 'nothing yet');
    writeFileSync(join(w.dir, 'notes.txt'), 'notes\n');
    mkdirSync(join(w.dir, 'test'));
    writeFileSync(join(w.dir, 'test', 'notes.test.mjs'), '// test\n');
    gmod(w.dir, 'note', 'about to write notes');
    assert.deepEqual(strayFiles(w.dir), [], 'the job\'s files, tests and journal are not stray');
    writeFileSync(join(w.dir, 'README.md'), 'hi\nhello\n');
    writeFileSync(join(w.dir, 'new.txt'), 'new\n');
    unlinkSync(join(w.dir, 'other.txt'));
    mkdirSync(join(w.dir, 'build'));
    writeFileSync(join(w.dir, 'build', 'out.js'), 'x\n');
    writeFileSync(join(w.dir, 'run.log'), 'x\n');
    assert.deepEqual(strayFiles(w.dir), ['README.md', 'new.txt', 'other.txt'], 'changed, new and deleted; ignored files are not');
  } finally { w.done(); }
});

test('strayFiles lists nothing without a claim', () => {
  const w = world({ claim: false });
  try {
    writeFileSync(join(w.dir, 'README.md'), 'changed\n');
    writeFileSync(join(w.dir, 'new.txt'), 'new\n');
    assert.deepEqual(strayFiles(w.dir), []);
  } finally { w.done(); }
});

test('after a shell command writes outside the job, Codex hears which file and how to put it back, once', () => {
  const w = world();
  try {
    writeFileSync(join(w.dir, 'notes.txt'), 'notes\n');
    assert.equal(hook(postBash(w.dir, "printf 'notes\\n' > notes.txt"), w.dir), '', 'inside the job: nothing to say');
    writeFileSync(join(w.dir, 'README.md'), 'hi\nhello\n');
    const said = context(hook(postBash(w.dir, "printf 'hello\\n' >> README.md"), w.dir));
    assert.match(said, /^gmod: this command changed files outside one: README\.md\./);
    assert.match(said, /git checkout -- /);
    assert.match(said, /remove a new file/);
    assert.match(said, /can't be committed with this job/);
    assert.equal(hook(postBash(w.dir, 'ls'), w.dir), '', 'said once');
    // A new stray changes the set: said again, with both.
    writeFileSync(join(w.dir, 'new.txt'), 'new\n');
    assert.match(context(hook(postBash(w.dir, 'echo new > new.txt'), w.dir)), /outside one: README\.md, new\.txt\./);
    assert.equal(hook(postBash(w.dir, 'ls'), w.dir), '', 'said once');
    // Put back, then strayed again: said again.
    sh(w.dir, 'git', ['checkout', '--', 'README.md']);
    rmSync(join(w.dir, 'new.txt'));
    assert.equal(hook(postBash(w.dir, 'git checkout -- README.md && rm new.txt'), w.dir), '', 'nothing stray now');
    writeFileSync(join(w.dir, 'README.md'), 'again\n');
    assert.match(context(hook(postBash(w.dir, 'echo again > README.md'), w.dir)), /outside one: README\.md\./);
  } finally { w.done(); }
});

test('without a claim, nothing is said after a shell write', () => {
  const w = world({ claim: false });
  try {
    writeFileSync(join(w.dir, 'README.md'), 'changed\n');
    assert.equal(hook(postBash(w.dir, 'echo changed > README.md'), w.dir), '');
  } finally { w.done(); }
});

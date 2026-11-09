// Test repositories inherit the person's global git config. With commit
// signing on, gpg fails under the parallel suite ("Cannot allocate memory")
// and random tests fail locally. test/setup.mjs, loaded by npm test, turns
// signing off for every git the tests run, through git's environment config,
// which wins over a repository's own config. gmod itself is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('under the test setup, a commit in a repository set to sign with a failing gpg still succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-signing-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@x.io');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'true');
    git('config', 'tag.gpgsign', 'true');
    git('config', 'gpg.program', 'false');
    writeFileSync(join(dir, 'a'), 'a\n');
    git('add', 'a');
    git('commit', '-q', '-m', 'signed? no');
    git('tag', '-a', 'v1', '-m', 'v1');
    assert.equal(git('log', '-1', '--format=%s'), 'signed? no');
    assert.equal(git('log', '-1', '--format=%G?'), 'N', 'not signed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm test loads the setup', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /node (?:\S+ )*--import \.\/test\/setup\.mjs (?:\S+ )*--test\b/);
});

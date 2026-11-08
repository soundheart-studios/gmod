// A decision's pull request (a plan, ADR, managed or CI change) is titled by
// the decision itself: the branch's tip. When local main still holds an
// earlier decision that hasn't landed, the branch carries it too, and the
// oldest commit is that earlier decision, not this one (#56 went out titled
// with ADR 0002's subject though it carried the 1.7 plan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishDecision } from '../lib/ci.mjs';

test('a plan change committed on top of an unlanded ADR commit opens its pull request titled with the plan commit\'s subject', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gmod-decision-title-'));
  const bare = join(root, 'origin.git');
  const dir = join(root, 'work');
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, dir], { stdio: 'ignore' });
  g('config', 'user.email', 'a@x.io'); g('config', 'user.name', 'a');
  mkdirSync(join(dir, '.gmod'));
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify({ checks: {}, jobs: [] }, null, 2) + '\n');
  g('add', '-A'); g('commit', '-q', '-m', 'seed'); g('push', '-q', 'origin', 'main');
  // An ADR accepted here, its pull request not landed yet.
  mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'adr', '0001-x.md'), '---\nid: 0001\ntitle: X\nstatus: accepted\n---\n## Rules\n- must: x\n');
  g('add', '-A'); g('commit', '-q', '-m', 'adr: 0001 X');
  // Then a plan change, approved on top of it.
  writeFileSync(join(dir, '.gmod', 'plan.json'), JSON.stringify({ checks: { t: 'true' }, jobs: [] }, null, 2) + '\n');
  g('add', '-A'); g('commit', '-q', '-m', 'plan: add t');
  const sha = g('rev-parse', 'HEAD');
  const log = join(root, 'gh.log');
  const fake = join(root, 'gh');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\ncat >/dev/null\necho https://github.com/acme/app/pull/9\n`, { mode: 0o755 });
  const before = process.env.GMOD_GH;
  process.env.GMOD_GH = fake;
  try {
    const r = await publishDecision(dir, { branch: `gmod/plan-${sha.slice(0, 7)}`, commit: sha, forge: { kind: 'github', owner: 'acme', repo: 'app' } });
    assert.equal(r.kind, 'plan');
    assert.equal(r.title, 'plan: add t');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const create = calls.find(c => c.startsWith('pr create'));
    assert.ok(create?.includes('plan: add t'), calls.join('; '));
    assert.ok(!create.includes('adr: 0001'), create);
  } finally {
    if (before === undefined) delete process.env.GMOD_GH; else process.env.GMOD_GH = before;
    rmSync(root, { recursive: true, force: true });
  }
});

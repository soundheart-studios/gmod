// The AI review against a real model. Opt in: GMOD_REVIEW_URL (an
// OpenAI-compatible /v1 address) or ANTHROPIC_API_KEY. Skipped otherwise.
//
//   GMOD_REVIEW_URL=http://ai.local:8080/v1 node --test test/review-live.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const live = !!(process.env.GMOD_REVIEW_URL || process.env.ANTHROPIC_API_KEY);

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-review-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@x.io');
  git('config', 'user.name', 'a');
  const put = fs => {
    for (const [f, t] of Object.entries(fs)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), t);
    }
  };
  put(files);
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  return { dir, git, put };
}

const PLAN = { main: 'main', checks: { sum: 'node test/sum.test.mjs' }, jobs: [{ id: 'add-sum', goal: 'Add two prices', files: ['src/sum.mjs'], tests: ['test/sum.test.mjs'], done_when: [{ text: '0.1 + 0.2 adds to 0.3', check: 'sum' }] }] };
const ADR = `---
id: 0001
title: Sums never round
status: accepted
scope: src/sum.mjs
date: 2026-11-01
---

## Context

Prices add up through sum; rounding there loses money silently.

## Decision

Sums stay exact: work in integer cents and never round inside sum.

## Rules
- must: never round inside sum (no Math.round, toFixed or similar)
- should: work in integer cents
`;

test('a change that breaks an ADR\'s must rule is a fail on that ADR', { skip: !live && 'set GMOD_REVIEW_URL or ANTHROPIC_API_KEY' }, () => {
  const r = repo({ '.gmod/plan.json': JSON.stringify(PLAN), 'docs/adr/0001-sums-never-round.md': ADR, 'src/sum.mjs': 'export const sum = () => 0;\n' });
  try {
    r.git('switch', '-q', '-c', 'gmod/add-sum');
    r.put({
      'src/sum.mjs': 'export function sum(a, b) {\n  return Math.round((a + b) * 100) / 100;\n}\n',
      'test/sum.test.mjs': 'import { sum } from "../src/sum.mjs";\nif (sum(0.1, 0.2) !== 0.3) process.exit(1);\n',
    });
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'add-sum: add two prices');
    const out = spawnSync('node', [join(here, '..', 'ci', 'review.mjs'), '--base', 'main', '--head', 'HEAD', '--branch', 'gmod/add-sum'], {
      cwd: r.dir,
      encoding: 'utf8',
      env: { ...process.env, GMOD_REVIEW_MODE: 'comment' },
    }).stdout;
    console.log(out);
    assert.match(out, /### gmod review: fail/);
    assert.match(out, /❌ \*\*(ADR )?0001/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

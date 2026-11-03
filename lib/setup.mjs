// gmod setup, gmod doctor, gmod ci upgrade: a repository's CI, once, from
// the forge's own CLI login. GitHub for now; on Gitea, gmod ci init.
//
//   setup    writes the workflow (the gmod action, pinned) and .gmod/protect.json,
//            protects main, and lands both as one governance pull request:
//            its landing is the proof that the whole loop works.
//   doctor   one line per thing that has to be right, each ✗ with its fix.
//   upgrade  a pull request that moves the pinned action to the newest release.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GmodError, PLAN, PROTECT, git, planAt, protectSpec } from './core.mjs';
import { ciProtect, detectForge, gh, githubProtection, openPr } from './ci.mjs';

export const ACTION = 'soundheart-studios/gmod';
export const WORKFLOW = '.github/workflows/gmod.yml';
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

// The whole workflow a repository holds: the action, pinned to a release.
export function actionWorkflow({ ref = `v${VERSION}`, reviewer = { kind: 'claude' }, blocking = true, setup = '' } = {}) {
  const inputs =
    reviewer.kind === 'none'
      ? []
      : reviewer.kind === 'claude'
        ? ['          reviewer-key: ${{ secrets.ANTHROPIC_API_KEY }}']
        : [`          reviewer-url: ${reviewer.url}`, ...(reviewer.model ? [`          reviewer-model: ${reviewer.model}`] : []), '          reviewer-key: ${{ secrets.GMOD_REVIEW_KEY }}'];
  if (!blocking) inputs.push("          blocking: 'false'");
  if (setup) inputs.push(`          setup: ${JSON.stringify(setup)}`);
  return [
    '# gmod: gates, reviews and lands every pull request; after each landing,',
    '# checks what landed and catches the other job branches up. Written by',
    '# gmod setup; gmod ci upgrade moves it to a newer release.',
    'name: gmod',
    'on:',
    '  pull_request:',
    '  push: { branches: [main] }',
    '  repository_dispatch: { types: [gmod] }',
    "  schedule: [{ cron: '17 * * * *' }]",
    'jobs:',
    '  gmod:',
    '    runs-on: ubuntu-latest',
    '    permissions: { contents: write, pull-requests: write, issues: write, statuses: write }',
    '    steps:',
    `      - uses: ${ACTION}@${ref}`,
    ...(inputs.length ? ['        with:', ...inputs] : []),
    '',
  ].join('\n');
}

export const reviewerSecret = reviewer => (reviewer.kind === 'none' ? null : reviewer.kind === 'claude' ? 'ANTHROPIC_API_KEY' : 'GMOD_REVIEW_KEY');

const show = (root, ref, path) => git(['show', `${ref}:${path}`], { cwd: root, allow: true });

function githubOnly(forge, what) {
  if (forge.kind !== 'github') throw new GmodError(`${what} is for GitHub for now; on Gitea: gmod ci init, then gmod ci protect`);
}

// ---------- doctor ----------

export async function doctor(root, { main = 'main', url } = {}) {
  const forge = detectForge(root, { url });
  githubOnly(forge, 'gmod doctor');
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  const findings = [];
  const add = (ok, msg, fix) => findings.push({ ok, msg, fix });
  const repo = `${forge.owner}/${forge.repo}`;

  const auth = gh(['auth', 'status']);
  add(auth.ok, auth.ok ? 'gh is signed in' : "gh isn't signed in", 'gh auth login');

  add(!!planAt(root, `origin/${main}`), planAt(root, `origin/${main}`) ? `a plan is on ${main}` : `no ${PLAN} on ${main}`, '/gmod:plan in Claude Code, then approve it');

  const wf = show(root, `origin/${main}`, WORKFLOW);
  const uses = wf.out.match(new RegExp(`uses: ${ACTION}@(\\S+)`))?.[1];
  add(!!uses, uses ? `the workflow runs gmod ${uses}` : `no gmod workflow on ${main}`, 'gmod setup');
  if (uses) {
    add(/repository_dispatch:[^\n]*gmod/.test(wf.out), /repository_dispatch:[^\n]*gmod/.test(wf.out) ? 'gmod can start its own follow-up runs' : "the workflow doesn't take gmod's follow-up runs: branches that catch up aren't checked again", 'gmod setup');
    const secret = wf.out.match(/reviewer-key: \$\{\{ secrets\.(\w+) \}\}/)?.[1];
    if (secret) {
      const list = gh(['secret', 'list', '--repo', repo, '--json', 'name', '-q', '.[].name']);
      const have = list.ok && list.out.split('\n').includes(secret);
      add(have, have ? `the reviewer's key is set (${secret})` : `the reviewer's key isn't set (${secret})`, `gh secret set ${secret} --repo ${repo}`);
    } else add(true, 'no reviewer: the gate alone decides');
    const latest = latestRelease();
    if (latest && newer(latest, uses)) add(false, `gmod ${latest} is out; this repository runs ${uses}`, 'gmod ci upgrade');
  }

  const spec = protectSpec(root, `origin/${main}`);
  add(!!spec, spec ? `${PROTECT} says ${main} requires ${spec.require.join(' and ')}` : `no ${PROTECT} on ${main}: nothing says what it requires`, 'gmod setup');
  if (spec) {
    const token = gh(['auth', 'token']);
    const f = await githubProtection({ forge, spec, token: token.ok ? token.out.trim() : '', main });
    add(f.ok, f.msg, 'gmod ci protect');
  }
  return { forge, findings, ok: findings.every(f => f.ok) };
}

// ---------- releases ----------

const parse = v => {
  const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null;
};
// Is a newer than b? A release beats its own release candidates.
export function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
export function latestOf(tags, { candidates = false } = {}) {
  return tags.filter(t => parse(t) && (candidates || !/-rc\./.test(t))).sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))[0] ?? null;
}
function latestRelease({ candidates } = {}) {
  const r = gh(['api', `repos/${ACTION}/tags`, '--paginate', '-q', '.[].name']);
  return r.ok ? latestOf(r.out.split('\n').filter(Boolean), { candidates }) : null;
}

// ---------- a governance pull request, from a scratch worktree ----------

async function governancePr(root, { main, branch, files, message, url }) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-setup-'));
  try {
    git(['fetch', '-q', 'origin', main], { cwd: root });
    git(['worktree', 'add', '-q', '-B', branch, dir, `origin/${main}`], { cwd: root });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(['add', '--', ...Object.keys(files)], { cwd: dir });
    git(['commit', '-q', '-F', '-'], { cwd: dir, input: message });
    git(['push', '-q', '--force-with-lease', '-u', 'origin', branch], { cwd: dir });
    return await openPr(dir, { main, branch, auto: true, url });
  } finally {
    git(['worktree', 'remove', '--force', dir], { cwd: root, allow: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

// Wait for a pull request to land: the proof that gate, review and landing work.
async function waitToLand(url, { minutes = 10, sleep = ms => new Promise(ok => setTimeout(ok, ms)) } = {}) {
  const started = Date.now();
  while (Date.now() - started < minutes * 60_000) {
    const r = gh(['pr', 'view', url, '--json', 'state,mergedAt,statusCheckRollup']);
    const pr = r.ok ? JSON.parse(r.out) : null;
    if (pr?.state === 'MERGED') return { landed: true, seconds: Math.round((Date.now() - started) / 1000) };
    const failed = (pr?.statusCheckRollup ?? []).find(c => /^gmod \/ /.test(c.context ?? c.name ?? '') && ['FAILURE', 'ERROR'].includes(c.state ?? c.conclusion));
    if (failed) return { landed: false, why: `${failed.context ?? failed.name} failed` };
    if (pr?.state === 'CLOSED') return { landed: false, why: 'it was closed' };
    await sleep(10_000);
  }
  return { landed: false, why: `not landed after ${minutes} minutes` };
}

// ---------- setup ----------

export async function setup(root, { main = 'main', url, reviewer = { kind: 'claude' }, blocking = true, setup: setupCmd = '', ref = `v${VERSION}`, wait = true, log = () => {} } = {}) {
  const forge = detectForge(root, { url });
  githubOnly(forge, 'gmod setup');
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  if (!planAt(root, `origin/${main}`)) throw new GmodError(`no ${PLAN} on ${main} yet: plan first (/gmod:plan in Claude Code), then gmod setup`);

  const requireReview = reviewer.kind !== 'none' && blocking;
  const files = {
    [WORKFLOW]: actionWorkflow({ ref, reviewer, blocking, setup: setupCmd }),
    [PROTECT]: `${JSON.stringify({ require: requireReview ? ['gate', 'review'] : ['gate'], up_to_date: true }, null, 2)}\n`,
  };
  const changed = Object.fromEntries(Object.entries(files).filter(([path, text]) => show(root, `origin/${main}`, path).out + '\n' !== text && show(root, `origin/${main}`, path).out !== text));
  const steps = [];
  const step = x => (steps.push(x), log(x));

  // main's rules first, so the pull request below already lands under them.
  try {
    const p = await ciProtect(root, { main, url, requireReview });
    step({ ok: true, msg: `${main} protected: ${p.required.join(' and ')} required on up-to-date branches, pull requests only` });
  } catch (e) {
    if (!/can't protect .* on this plan/.test(e.message)) throw e;
    step({ ok: true, msg: e.message });
  }

  if (!Object.keys(changed).length) {
    step({ ok: true, msg: `the workflow (gmod ${ref}) and ${PROTECT} are already on ${main}` });
  } else {
    const pr = await governancePr(root, {
      main,
      url,
      branch: 'gmod/setup',
      files: changed,
      message: `ci: gmod ${ref}, and what ${main} requires\n\nWritten by gmod setup.\n`,
    });
    step({ ok: true, msg: `governance pull request: ${pr.url} (${Object.keys(changed).join(', ')})` });
    if (wait) {
      const w = await waitToLand(pr.url);
      step(w.landed ? { ok: true, msg: `it landed by itself in ${w.seconds}s: gate, review and landing work` } : { ok: false, msg: `it hasn't landed: ${w.why}. Its checks say why: ${pr.url}` });
    }
  }

  const secret = reviewerSecret(reviewer);
  if (secret) {
    const list = gh(['secret', 'list', '--repo', `${forge.owner}/${forge.repo}`, '--json', 'name', '-q', '.[].name']);
    if (!(list.ok && list.out.split('\n').includes(secret))) step({ ok: false, msg: `the reviewer's key isn't set yet: gh secret set ${secret} --repo ${forge.owner}/${forge.repo}` });
  }
  return { forge, steps, ok: steps.every(s => s.ok) };
}

// ---------- upgrade ----------

export async function upgrade(root, { main = 'main', url, to, candidates = false } = {}) {
  const forge = detectForge(root, { url });
  githubOnly(forge, 'gmod ci upgrade');
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  const wf = show(root, `origin/${main}`, WORKFLOW).out;
  const current = wf.match(new RegExp(`uses: ${ACTION}@(\\S+)`))?.[1];
  if (!current) throw new GmodError(`no gmod workflow on ${main}: gmod setup`);
  to ??= latestRelease({ candidates });
  if (!to) throw new GmodError(`couldn't read gmod's releases from ${ACTION}`);
  if (to === current || (parse(current) && !newer(to, current))) return { forge, current, to, upToDate: true };
  const text = wf.replace(`uses: ${ACTION}@${current}`, `uses: ${ACTION}@${to}`);
  const pr = await governancePr(root, { main, url, branch: 'gmod/ci-upgrade', files: { [WORKFLOW]: text }, message: `ci: gmod ${to} (was ${current})\n\nWritten by gmod ci upgrade.\n` });
  return { forge, current, to, pr };
}

// gmod setup, gmod doctor, gmod ci upgrade: a repository's CI, once, from
// the forge's own CLI login (gh on GitHub, glab on GitLab); on Gitea, gmod
// ci init.
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
import { CI_FILE, COMPONENT, componentInclude, gitlabApi, gitlabProtection, glab, projectId, withComponent } from './gitlab.mjs';

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

function supported(forge, what) {
  if (forge.kind !== 'github' && forge.kind !== 'gitlab') throw new GmodError(`${what} is for GitHub and GitLab for now; on Gitea: gmod ci init, then gmod ci protect`);
}

// GitLab: the include line in .gitlab-ci.yml, and the version it pins.
const COMPONENT_RE = new RegExp(`component: \\S*/${COMPONENT}/gmod@(\\S+)`);
// The project variables gmod's GitLab jobs need: a person's token, and the reviewer's key.
const gitlabVariables = async forge => {
  const r = await gitlabApi(forge, 'GET', `/projects/${projectId(forge)}/variables?per_page=100`);
  return r.ok ? (r.json ?? []).map(v => v.key) : null;
};
const setVariable = (forge, name) => `glab variable set ${name} --masked --repo ${forge.path}`;
const TOKEN_HELP = 'a personal access token with api and write_repository: GitLab → Preferences → Access tokens';

// ---------- doctor ----------

export async function doctor(root, { main = 'main', url } = {}) {
  const forge = detectForge(root, { url });
  supported(forge, 'gmod doctor');
  if (forge.kind === 'gitlab') return gitlabDoctor(root, { forge, main });
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

async function gitlabDoctor(root, { forge, main }) {
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  const findings = [];
  const add = (ok, msg, fix) => findings.push({ ok, msg, fix });

  const auth = glab(['auth', 'status', '--hostname', forge.host]);
  const signedIn = auth.ok && !/x .*(401|Unauthorized)|No token found/.test(auth.out + auth.err);
  add(signedIn, signedIn ? 'glab is signed in' : "glab isn't signed in", `glab auth login --hostname ${forge.host}`);

  add(!!planAt(root, `origin/${main}`), planAt(root, `origin/${main}`) ? `a plan is on ${main}` : `no ${PLAN} on ${main}`, '/gmod:plan in Claude Code, then approve it');

  const ci = show(root, `origin/${main}`, CI_FILE);
  const uses = ci.out.match(COMPONENT_RE)?.[1];
  add(!!uses, uses ? `the pipeline runs gmod ${uses}` : `no gmod component in ${CI_FILE} on ${main}`, 'gmod setup');
  if (uses) {
    const vars = await gitlabVariables(forge);
    if (!vars) add(false, "couldn't list the project's CI/CD variables (it needs the Maintainer role)", 'glab auth login with a Maintainer');
    else {
      add(vars.includes('GMOD_GITLAB_TOKEN'), vars.includes('GMOD_GITLAB_TOKEN') ? 'GMOD_GITLAB_TOKEN is set: gmod can comment, land and catch up' : `GMOD_GITLAB_TOKEN isn't set (${TOKEN_HELP})`, setVariable(forge, 'GMOD_GITLAB_TOKEN'));
      const review = ci.out.match(/review: (\S+)/)?.[1] ?? 'blocking';
      const key = review === 'off' ? null : /reviewer-url:/.test(ci.out) ? 'GMOD_REVIEW_KEY' : 'ANTHROPIC_API_KEY';
      if (key) add(vars.includes(key), vars.includes(key) ? `the reviewer's key is set (${key})` : `the reviewer's key isn't set (${key})`, setVariable(forge, key));
      else add(true, 'no reviewer: the gate alone decides');
    }
    const sched = await gitlabApi(forge, 'GET', `/projects/${projectId(forge)}/pipeline_schedules`);
    const hourly = sched.ok && (sched.json ?? []).some(x => x.active && /gmod/.test(x.description ?? ''));
    add(hourly, hourly ? "the hourly look at what isn't landing is scheduled" : 'no hourly pipeline schedule: stuck jobs go unreported', 'gmod setup');
    const latest = gitlabLatest(forge);
    if (latest && newer(latest, uses)) add(false, `gmod ${latest} is out; this project runs ${uses}`, 'gmod ci upgrade');
  }
  // Hosted runners on GitLab.com start nothing for an unverified account.
  const last = glab(['api', '--hostname', forge.host, 'graphql', '-f', `query={ project(fullPath:"${forge.path}"){ pipelines(first:1){ nodes{ status failureReason } } } }`]);
  let reason = null;
  try { reason = last.ok ? JSON.parse(last.out).data?.project?.pipelines?.nodes?.[0]?.failureReason : null; } catch { /* unread */ }
  if (reason && /not being verified|verif/i.test(reason)) add(false, `pipelines don't start: ${reason}`, 'open the failed pipeline and select "Verify my account"');

  const spec = protectSpec(root, `origin/${main}`);
  add(!!spec, spec ? `${PROTECT} says ${main} requires ${spec.require.join(' and ')}` : `no ${PROTECT} on ${main}: nothing says what it requires`, 'gmod setup');
  if (spec) {
    const f = await gitlabProtection({ forge, spec, main });
    add(f.ok, f.msg, 'gmod ci protect');
  }
  return { forge, findings, ok: findings.every(f => f.ok) };
}

function gitlabLatest(forge, { candidates } = {}) {
  const r = glab(['api', '--hostname', forge.host, `projects/${encodeURIComponent(COMPONENT)}/repository/tags?per_page=100`]);
  try {
    return r.ok ? latestOf(JSON.parse(r.out).map(t => t.name), { candidates }) : null;
  } catch {
    return null;
  }
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
async function waitToLand(url, { minutes = 10, sleep = ms => new Promise(ok => setTimeout(ok, ms)), forge } = {}) {
  const started = Date.now();
  if (forge?.kind === 'gitlab') {
    const iid = url.match(/(\d+)$/)[1];
    while (Date.now() - started < minutes * 60_000) {
      const r = await gitlabApi(forge, 'GET', `/projects/${projectId(forge)}/merge_requests/${iid}`);
      const mr = r.ok ? r.json : null;
      if (mr?.state === 'merged') return { landed: true, seconds: Math.round((Date.now() - started) / 1000) };
      if (mr?.state === 'closed') return { landed: false, why: 'it was closed' };
      // A failed pipeline on its newest commit: a catch-up starts a new one.
      if (mr?.head_pipeline?.status === 'failed' && mr.head_pipeline.sha === mr.sha) return { landed: false, why: 'its pipeline failed' };
      await sleep(10_000);
    }
    return { landed: false, why: `not landed after ${minutes} minutes` };
  }
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
  supported(forge, 'gmod setup');
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  if (!planAt(root, `origin/${main}`)) throw new GmodError(`no ${PLAN} on ${main} yet: plan first (/gmod:plan in Claude Code), then gmod setup`);

  const requireReview = reviewer.kind !== 'none' && blocking;
  const gitlab = forge.kind === 'gitlab';
  const steps = [];
  const step = x => (steps.push(x), log(x));
  if (gitlab) {
    // gmod's jobs comment, land and catch up as a person: without the token
    // the governance merge request below would only fail.
    const vars = await gitlabVariables(forge);
    if (!vars) throw new GmodError(`couldn't list ${forge.path}'s CI/CD variables: glab needs to be signed in as a Maintainer`);
    const need = ['GMOD_GITLAB_TOKEN', reviewerSecret(reviewer)].filter(Boolean).filter(v => !vars.includes(v));
    if (need.length) {
      for (const v of need) step({ ok: false, msg: `${v} isn't set: ${setVariable(forge, v)}${v === 'GMOD_GITLAB_TOKEN' ? ` (${TOKEN_HELP})` : ''}` });
      return { forge, steps, ok: false };
    }
  }
  const existingCi = gitlab ? show(root, `origin/${main}`, CI_FILE) : null;
  const files = {
    [gitlab ? CI_FILE : WORKFLOW]: gitlab
      ? withComponent(existingCi.ok ? existingCi.out + '\n' : null, componentInclude({ ref, host: forge.host, reviewer, blocking, setup: setupCmd }))
      : actionWorkflow({ ref, reviewer, blocking, setup: setupCmd }),
    [PROTECT]: `${JSON.stringify({ require: requireReview ? ['gate', 'review'] : ['gate'], up_to_date: true }, null, 2)}\n`,
  };
  const changed = Object.fromEntries(Object.entries(files).filter(([path, text]) => show(root, `origin/${main}`, path).out + '\n' !== text && show(root, `origin/${main}`, path).out !== text));

  // main's rules first, so the pull request below already lands under them.
  try {
    const p = await ciProtect(root, { main, url, requireReview });
    step({ ok: true, msg: gitlab ? `${main} protected: merge requests only, merged once their pipeline (${p.required.join(' and ')}) passes, up to date with ${main}` : `${main} protected: ${p.required.join(' and ')} required on up-to-date branches, pull requests only` });
  } catch (e) {
    if (!/can't protect .* on this plan/.test(e.message)) throw e;
    step({ ok: true, msg: e.message });
  }

  if (gitlab) {
    // The hourly look at what isn't landing: a pipeline schedule.
    const id = projectId(forge);
    const list = await gitlabApi(forge, 'GET', `/projects/${id}/pipeline_schedules`);
    if (!(list.ok && (list.json ?? []).some(x => /gmod/.test(x.description ?? '')))) {
      const r = await gitlabApi(forge, 'POST', `/projects/${id}/pipeline_schedules`, { description: "gmod: what isn't landing", ref: main, cron: '17 * * * *', active: true });
      step(r.ok ? { ok: true, msg: "hourly look at what isn't landing scheduled" } : { ok: false, msg: `couldn't schedule the hourly look (${r.status}): ${JSON.stringify(r.json)}` });
    }
  }

  if (!Object.keys(changed).length) {
    step({ ok: true, msg: `the ${gitlab ? 'component' : 'workflow'} (gmod ${ref}) and ${PROTECT} are already on ${main}` });
  } else {
    const pr = await governancePr(root, {
      main,
      url,
      branch: 'gmod/setup',
      files: changed,
      message: `ci: gmod ${ref}, and what ${main} requires\n\nWritten by gmod setup.\n`,
    });
    step({ ok: true, msg: `governance ${gitlab ? 'merge' : 'pull'} request: ${pr.url} (${Object.keys(changed).join(', ')})` });
    if (wait) {
      const w = await waitToLand(pr.url, { forge });
      step(w.landed ? { ok: true, msg: `it landed by itself in ${w.seconds}s: gate, review and landing work` } : { ok: false, msg: `it hasn't landed: ${w.why}. Its checks say why: ${pr.url}` });
    }
  }

  const secret = reviewerSecret(reviewer);
  if (secret && !gitlab) {
    const list = gh(['secret', 'list', '--repo', `${forge.owner}/${forge.repo}`, '--json', 'name', '-q', '.[].name']);
    if (!(list.ok && list.out.split('\n').includes(secret))) step({ ok: false, msg: `the reviewer's key isn't set yet: gh secret set ${secret} --repo ${forge.owner}/${forge.repo}` });
  }
  return { forge, steps, ok: steps.every(s => s.ok) };
}

// ---------- upgrade ----------

export async function upgrade(root, { main = 'main', url, to, candidates = false } = {}) {
  const forge = detectForge(root, { url });
  supported(forge, 'gmod ci upgrade');
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  if (forge.kind === 'gitlab') {
    const ci = show(root, `origin/${main}`, CI_FILE).out;
    const current = ci.match(COMPONENT_RE)?.[1];
    if (!current) throw new GmodError(`no gmod component in ${CI_FILE} on ${main}: gmod setup`);
    to ??= gitlabLatest(forge, { candidates });
    if (!to) throw new GmodError(`couldn't read gmod's releases from ${forge.host}/${COMPONENT}`);
    if (to === current || (parse(current) && !newer(to, current))) return { forge, current, to, upToDate: true };
    const text = ci.replace(`/${COMPONENT}/gmod@${current}`, `/${COMPONENT}/gmod@${to}`);
    const pr = await governancePr(root, { main, url, branch: 'gmod/ci-upgrade', files: { [CI_FILE]: text.endsWith('\n') ? text : text + '\n' }, message: `ci: gmod ${to} (was ${current})\n\nWritten by gmod ci upgrade.\n` });
    return { forge, current, to, pr };
  }
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

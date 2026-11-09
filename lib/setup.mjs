// gmod setup, gmod doctor, gmod ci upgrade: a repository's CI, once, from
// the forge's own CLI login (gh on GitHub, glab on GitLab, tea's on Gitea).
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
import { GmodError, PLAN, PROTECT, decideOnMain, decidedBy, git, planAt, protectSpec } from './core.mjs';
import { MANAGED, MANAGED_VERSION, setManaged } from './managed.mjs';
import { ciForgeToken, ciProtect, detectForge, gh, giteaToken, githubProtection, githubRunnerFinding, openPr, protectionMatches, publishDecision } from './ci.mjs';
import { CI_FILE, COMPONENT, componentInclude, gitlabApi, gitlabProtection, glab, projectId, withComponent } from './gitlab.mjs';

export const ACTION = 'soundheart-studios/gmod';
export const WORKFLOW = '.github/workflows/gmod.yml';
export const GITEA_WORKFLOW = '.gitea/workflows/gmod.yml';

// Where a Gitea finds gmod: a copy on that same Gitea, as owner/repo (its
// Actions fetch other actions from github.com, where gmod may be private, and
// clone actions without signing in). The workflow checks it out with the
// person's token and runs it as a local action.
// git config gmod.<host>.action <owner/repo> says where; else <owner>/gmod.
export function giteaAction(root, forge) {
  return git(['config', '--get', `gmod.${forge.host}.action`], { cwd: root, allow: true }).out || `${forge.owner}/gmod`;
}
// The pinned gmod in a Gitea workflow.
const giteaPinRe = action => new RegExp(`repository: ${escape(action)}\\n\\s+ref: (\\S+)`);
const escape = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

// The whole workflow a repository holds: the action, pinned to a release.
export function actionWorkflow({ ref = `v${VERSION}`, reviewer = { kind: 'claude' }, blocking = true, setup = '', forge = 'github', action = ACTION, runsOn = 'ubuntu-latest', agents = 0, app = false } = {}) {
  const gitea = forge === 'gitea';
  const inputs =
    reviewer.kind === 'none'
      ? []
      : reviewer.kind === 'claude'
        ? ['          reviewer-key: ${{ secrets.ANTHROPIC_API_KEY }}']
        : [`          reviewer-url: ${reviewer.url}`, ...(reviewer.model ? [`          reviewer-model: ${reviewer.model}`] : []), ...(keyless(reviewer) ? [] : ['          reviewer-key: ${{ secrets.GMOD_REVIEW_KEY }}'])];
  if (!blocking) inputs.push("          blocking: 'false'");
  if (setup) inputs.push(`          setup: ${JSON.stringify(setup)}`);
  // A GitHub App to work as (gmod app create).
  if (app && forge === 'github') inputs.push('          app-id: ${{ secrets.GMOD_APP_ID }}', '          app-key: ${{ secrets.GMOD_APP_KEY }}');
  // Agents in CI.
  if (agents && forge !== 'gitlab') inputs.push('          agent-key: ${{ secrets.GMOD_AGENT_KEY }}', `          agents: ${agents}`);
  // On Gitea, a person's token: CI's own can't read main's protection, and
  // what it pushes starts no run.
  if (gitea) inputs.push('          forge-token: ${{ secrets.GMOD_FORGE_TOKEN }}', "          checkout: 'false'");
  return [
    '# gmod: gates, reviews and lands every pull request; after each landing,',
    '# checks what landed and catches the other job branches up. Written by',
    '# gmod setup; gmod ci upgrade moves it to a newer release.',
    'name: gmod',
    'on:',
    ...(gitea
      ? [
          // Gitea: block style, and the pull request events spelled out.
          '  pull_request:',
          '    types: [opened, synchronize, reopened, edited, labeled, unlabeled]',
          '  push:',
          '    branches: [main]',
          '  issue_comment:',
          '    types: [created]',
          '  schedule:',
          "    - cron: '17 * * * *'",
        ]
      : ['  pull_request: { types: [opened, synchronize, reopened, unlabeled] }', '  push: { branches: [main] }', '  repository_dispatch: { types: [gmod] }', '  issue_comment: { types: [created] }', "  schedule: [{ cron: '17 * * * *' }]"]),
    'jobs:',
    '  gmod:',
    `    runs-on: ${runsOn}`,
    ...(gitea ? [] : ['    permissions: { contents: write, pull-requests: write, issues: write, statuses: write }']),
    '    steps:',
    ...(gitea
      ? [
          '      - uses: actions/checkout@v4',
          '        with: { fetch-depth: 0 }',
          '      - uses: actions/checkout@v4',
          // Block style: ${{ }} inside a {flow} mapping isn't valid YAML.
          '        with:',
          `          repository: ${action}`,
          `          ref: ${ref}`,
          '          path: .gmod-tool',
          '          token: ${{ secrets.GMOD_FORGE_TOKEN }}',
          '      - uses: ./.gmod-tool',
        ]
      : [`      - uses: ${action}@${ref}`]),
    ...(inputs.length ? ['        with:', ...inputs] : []),
    '',
  ].join('\n');
}

// A model on the runner's own machine needs no key.
const keyless = reviewer => !!reviewer.url && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(reviewer.url);
// Agents in CI open pull requests with CI's own token: GitHub refuses that
// unless the repository lets Actions create pull requests.
const actionsPrs = repo => {
  const r = gh(['api', `repos/${repo}/actions/permissions/workflow`, '-q', '.can_approve_pull_request_reviews']);
  return r.ok ? r.out.trim() === 'true' : null;
};
const ACTIONS_PRS_FIX = repo => `gh api -X PUT repos/${repo}/actions/permissions/workflow -F can_approve_pull_request_reviews=true -f default_workflow_permissions=read`;

export const reviewerSecret = reviewer => (reviewer.kind === 'none' || keyless(reviewer) ? null : reviewer.kind === 'claude' ? 'ANTHROPIC_API_KEY' : 'GMOD_REVIEW_KEY');

const show = (root, ref, path) => git(['show', `${ref}:${path}`], { cwd: root, allow: true });

function supported(forge, what) {
  if (!['github', 'gitlab', 'gitea'].includes(forge.kind)) throw new GmodError(`${what} doesn't know ${forge.kind}`);
}

// ---------- Gitea ----------

async function giteaApi(forge, token, method, path, body) {
  if (!forge.api) throw new GmodError("this Gitea's web address isn't known from origin: git config --global gmod.<host>.url http://host:port");
  const res = await fetch(`${forge.api}${path}`, { method, headers: { authorization: `token ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { text }; }
  return { ok: res.ok, status: res.status, json };
}
const giteaLogin = forge => giteaToken({ web: forge.web });
const giteaSecrets = async (forge, token) => {
  const r = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/actions/secrets?limit=50`);
  return r.ok ? (r.json ?? []).map(x => x.name) : null;
};
// The action's releases: tags on the Gitea that holds the copy of gmod.
async function giteaLatest(forge, token, action, { candidates } = {}) {
  const res = await fetch(`${forge.api}/repos/${action}/tags?limit=50`, { headers: { authorization: `token ${token}` } }).catch(() => null);
  if (!res?.ok) return null;
  return latestOf((await res.json()).map(t => t.name), { candidates });
}
// Runners that serve this repository with a label: its own, its owner's, yours.
async function giteaRunner(forge, token, label) {
  for (const path of [`/repos/${forge.owner}/${forge.repo}/actions/runners`, `/orgs/${forge.owner}/actions/runners`, '/user/actions/runners', '/admin/actions/runners']) {
    const r = await giteaApi(forge, token, 'GET', path).catch(() => ({ ok: false }));
    const found = r.ok && (r.json?.runners ?? []).find(x => (x.labels ?? []).some(l => (l.name ?? l) === label));
    if (found) return found;
  }
  // An instance's runners need an admin's token to list: the runner that
  // took this repository's latest job is the next best proof.
  const runs = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/actions/runs?limit=5`).catch(() => ({ ok: false }));
  for (const run of runs.ok ? runs.json?.workflow_runs ?? [] : []) {
    const jobs = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/actions/runs/${run.id}/jobs`).catch(() => ({ ok: false }));
    const job = (jobs.ok ? jobs.json?.jobs ?? [] : []).find(j => j.runner_name && (j.labels ?? [label]).includes(label));
    if (job) return { name: job.runner_name, status: `took the latest job, ${run.updated_at?.slice(0, 16).replace('T', ' ')}` };
  }
  return null;
}

async function giteaDoctor(root, { forge, main }) {
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  const findings = [];
  const add = (ok, msg, fix) => findings.push({ ok, msg, fix });
  const token = giteaLogin(forge);
  add(!!token, token ? `signed in to ${forge.web}` : `no login for ${forge.web}`, `tea login add --url ${forge.web}`);
  add(!!planAt(root, `origin/${main}`), planAt(root, `origin/${main}`) ? `a plan is on ${main}` : `no ${PLAN} on ${main}`, '/gmod:plan in Claude Code, then approve it');
  const action = giteaAction(root, forge);
  const wf = show(root, `origin/${main}`, GITEA_WORKFLOW);
  const uses = wf.out.match(giteaPinRe(action))?.[1];
  add(!!uses, uses ? `the workflow runs gmod ${uses}` : `no gmod in ${GITEA_WORKFLOW} on ${main}`, 'gmod setup');
  if (uses && token) {
    const label = wf.out.match(/runs-on: (\S+)/)?.[1];
    const runner = label ? await giteaRunner(forge, token, label) : null;
    add(!!runner, runner ? `runner ${runner.name} (${runner.status}) takes ${label}` : `no runner takes ${label}`, `gmod runner up --labels ${label}`);
    const secrets = await giteaSecrets(forge, token);
    if (!secrets) add(false, "couldn't list the repository's secrets (it needs an admin's token)", 'tea login add with a repository admin');
    else {
      add(secrets.includes('GMOD_FORGE_TOKEN'), secrets.includes('GMOD_FORGE_TOKEN') ? 'GMOD_FORGE_TOKEN is set: the gate reads main\'s protection, and branches brought up to date are checked again' : "GMOD_FORGE_TOKEN isn't set", 'gmod ci forge-token');
      const key = wf.out.match(/reviewer-key: \$\{\{ secrets\.(\w+) \}\}/)?.[1];
      if (key) add(secrets.includes(key), secrets.includes(key) ? `the reviewer's key is set (${key})` : `the reviewer's key isn't set (${key})`, `gmod ci secret ${key}`);
    }
    const latest = await giteaLatest(forge, token, action);
    if (latest && newer(latest, uses)) add(false, `gmod ${latest} is out; this repository runs ${uses}`, 'gmod ci upgrade');
  }
  const spec = protectSpec(root, `origin/${main}`);
  add(!!spec, spec ? `${PROTECT} says ${main} requires ${spec.require.join(' and ')}` : `no ${PROTECT} on ${main}: nothing says what it requires`, 'gmod setup');
  if (spec && token) {
    const f = await protectionMatches(root, { spec, token, main, forge });
    add(f.ok, f.msg, 'gmod ci protect');
  }
  return { forge, findings, ok: findings.every(f => f.ok) };
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
  if (forge.kind === 'gitea') return giteaDoctor(root, { forge, main });
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
    // How a branch CI brings up to date with main gets checked again: the
    // GitHub App's pushes start runs by themselves; otherwise gmod dispatches one.
    const viaApp = /^\s*app-id:\s*\S/m.test(wf.out) && /^\s*app-key:\s*\S/m.test(wf.out);
    const viaDispatch = /repository_dispatch:[^\n]*gmod/.test(wf.out);
    add(viaApp || viaDispatch,
      viaApp ? 'branches CI catches up are checked again through the GitHub App: its pushes start runs by themselves'
        : viaDispatch ? 'branches CI catches up are checked again through repository_dispatch: gmod starts their runs'
          : "branches CI catches up aren't checked again: the workflow has no GitHub App keys and doesn't take gmod's repository_dispatch",
      'gmod setup');
    // A self-hosted label no runner carries: every run waits, and nothing says why.
    const runner = githubRunnerFinding(forge, wf.out);
    if (runner) add(runner.ok, runner.msg, runner.fix);
    const secret = wf.out.match(/reviewer-key: \$\{\{ secrets\.(\w+) \}\}/)?.[1];
    if (secret) {
      const list = gh(['secret', 'list', '--repo', repo, '--json', 'name', '-q', '.[].name']);
      const have = list.ok && list.out.split('\n').includes(secret);
      add(have, have ? `the reviewer's key is set (${secret})` : `the reviewer's key isn't set (${secret})`, `gh secret set ${secret} --repo ${repo}`);
    } else add(true, 'no reviewer: the gate alone decides');
    if (/agent-key:/.test(wf.out)) {
      const list = gh(['secret', 'list', '--repo', repo, '--json', 'name', '-q', '.[].name']);
      const key = list.ok && list.out.split('\n').includes('GMOD_AGENT_KEY');
      add(key, key ? "agents in CI have their key (GMOD_AGENT_KEY)" : "agents in CI have no key (GMOD_AGENT_KEY)", `gh secret set GMOD_AGENT_KEY --repo ${repo}`);
      const prs = actionsPrs(repo);
      add(prs === true, prs ? 'Actions may open pull requests: agents in CI can finish their jobs' : "Actions may not open pull requests: agents in CI can't finish their jobs", ACTIONS_PRS_FIX(repo));
    }
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

async function governancePr(root, { main, branch, files, message, url, token }) {
  const dir = mkdtempSync(join(tmpdir(), 'gmod-setup-'));
  try {
    // --prune: a branch of the same name that landed and was deleted
    // mustn't leave a stale lease for the push below.
    git(['fetch', '-q', '--prune', 'origin'], { cwd: root });
    git(['worktree', 'add', '-q', '-B', branch, dir, `origin/${main}`], { cwd: root });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(['add', '--', ...Object.keys(files)], { cwd: dir });
    git(['commit', '-q', '-F', '-'], { cwd: dir, input: message });
    git(['push', '-q', '--force-with-lease', '-u', 'origin', branch], { cwd: dir });
    return await openPr(dir, { main, branch, auto: true, url, token });
  } finally {
    git(['worktree', 'remove', '--force', dir], { cwd: root, allow: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

// Wait for a pull request to land: the proof that gate, review and landing work.
async function waitToLand(url, { minutes = 10, sleep = ms => new Promise(ok => setTimeout(ok, ms)), forge, token } = {}) {
  const started = Date.now();
  if (forge?.kind === 'gitea') {
    const number = url.match(/(\d+)$/)[1];
    while (Date.now() - started < minutes * 60_000) {
      const r = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/pulls/${number}`);
      const pr = r.ok ? r.json : null;
      if (pr?.merged) return { landed: true, seconds: Math.round((Date.now() - started) / 1000) };
      if (pr?.state === 'closed') return { landed: false, why: 'it was closed' };
      const st = pr ? await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/commits/${pr.head.sha}/status`) : null;
      const failed = (st?.ok ? st.json?.statuses ?? [] : []).find(x => /^gmod \/ /.test(x.context) && ['failure', 'error'].includes(x.status ?? x.state));
      if (failed) return { landed: false, why: `${failed.context} failed` };
      await sleep(10_000);
    }
    return { landed: false, why: `not landed after ${minutes} minutes` };
  }
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

export async function setup(root, { main = 'main', url, reviewer = { kind: 'claude' }, blocking = true, setup: setupCmd = '', ref = `v${VERSION}`, wait = true, runsOn, agents = 0, app = false, managed = false, via = 'cli', log = () => {} } = {}) {
  const forge = detectForge(root, { url });
  supported(forge, 'gmod setup');
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  // No plan on main yet: setup brings a starter plan (no jobs) in its pull
  // request, so the repository is governed from the moment it lands.
  const governed = !!planAt(root, `origin/${main}`);

  const requireReview = reviewer.kind !== 'none' && blocking;
  const gitlab = forge.kind === 'gitlab';
  const gitea = forge.kind === 'gitea';
  const token = gitea ? giteaLogin(forge) : undefined;
  if (gitea && !token) throw new GmodError(`no login for ${forge.web}: tea login add --url ${forge.web}`);
  // Each step: an id, done | skipped | failed, and what happened in words;
  // ok and msg as before. What the person still has to do goes in `left`.
  const steps = [];
  const left = [];
  let pr = null;
  const step = (id, status, detail, { leave } = {}) => {
    const s = { id, status, detail, ok: status !== 'failed' && !leave, msg: detail };
    if (leave) left.push(leave);
    steps.push(s);
    log(s);
  };
  const result = () => ({ forge, ok: steps.every(s => s.ok), steps, pr, left });
  if (gitlab) {
    // gmod's jobs comment, land and catch up as a person: without the token
    // the governance merge request below would only fail.
    const vars = await gitlabVariables(forge);
    if (!vars) throw new GmodError(`couldn't list ${forge.path}'s CI/CD variables: glab needs to be signed in as a Maintainer`);
    const need = ['GMOD_GITLAB_TOKEN', reviewerSecret(reviewer)].filter(Boolean).filter(v => !vars.includes(v));
    if (need.length) {
      for (const v of need) step(`variable-${v}`, 'skipped', `${v} isn't set: ${setVariable(forge, v)}${v === 'GMOD_GITLAB_TOKEN' ? ` (${TOKEN_HELP})` : ''}`, { leave: `add ${v} as a CI/CD variable: ${setVariable(forge, v)}` });
      return result();
    }
  }
  if (gitea) {
    // The gate reads main's protection, and catch-up starts runs, as the person.
    const secrets = await giteaSecrets(forge, token);
    if (!secrets) throw new GmodError(`couldn't list ${forge.owner}/${forge.repo}'s secrets: the login needs to be a repository admin`);
    if (!secrets.includes('GMOD_FORGE_TOKEN')) {
      await ciForgeToken(root, { url, token });
      step('forge-token', 'done', 'GMOD_FORGE_TOKEN set from your login');
    }
    const key = reviewerSecret(reviewer);
    if (key && !secrets.includes(key)) {
      step('reviewer-key', 'skipped', `${key} isn't set: gmod ci secret ${key} --from-file <file>`, { leave: `add ${key} as a repository secret: gmod ci secret ${key} --from-file <file>` });
      return result();
    }
  }
  const existingCi = gitlab ? show(root, `origin/${main}`, CI_FILE) : null;
  const files = {
    [gitlab ? CI_FILE : gitea ? GITEA_WORKFLOW : WORKFLOW]: gitlab
      ? withComponent(existingCi.ok ? existingCi.out + '\n' : null, componentInclude({ ref, host: forge.host, reviewer, blocking, setup: setupCmd, agents }))
      : gitea
        ? actionWorkflow({ ref, reviewer, blocking, setup: setupCmd, forge: 'gitea', action: giteaAction(root, forge), runsOn: runsOn ?? 'ubuntu-latest', agents })
        : actionWorkflow({ ref, reviewer, blocking, setup: setupCmd, runsOn: runsOn ?? 'ubuntu-latest', agents, app }),
    [PROTECT]: `${JSON.stringify({ require: requireReview ? ['gate', 'review'] : ['gate'], up_to_date: true }, null, 2)}\n`,
  };
  if (!governed) files[PLAN] = `${JSON.stringify({ main, checks: {}, jobs: [] }, null, 2)}\n`;
  // Managed mode in the same pull request when main has no plan yet (nothing
  // governs it, so the gate takes it whole); on a governed main the switch
  // must land alone, so it goes up as its own decision, as gmod manage on.
  const managedHere = managed && !governed;
  if (managedHere) files[MANAGED] = `${JSON.stringify({ v: MANAGED_VERSION, managed: true }, null, 2)}\n`;
  const changed = Object.fromEntries(Object.entries(files).filter(([path, text]) => show(root, `origin/${main}`, path).out + '\n' !== text && show(root, `origin/${main}`, path).out !== text));

  // main's rules first, so the pull request below already lands under them.
  try {
    const p = await ciProtect(root, { main, url, requireReview, token });
    step('protect', 'done', gitlab ? `${main} protected: merge requests only, merged once their pipeline (${p.required.join(' and ')}) passes, up to date with ${main}` : `${main} protected: ${p.required.join(' and ')} required on up-to-date branches, pull requests only`);
  } catch (e) {
    if (!/can't protect .* on this plan/.test(e.message)) throw e;
    step('protect', 'skipped', e.message);
  }

  if (gitlab) {
    // The hourly look at what isn't landing: a pipeline schedule.
    const id = projectId(forge);
    const list = await gitlabApi(forge, 'GET', `/projects/${id}/pipeline_schedules`);
    if (!(list.ok && (list.json ?? []).some(x => /gmod/.test(x.description ?? '')))) {
      const r = await gitlabApi(forge, 'POST', `/projects/${id}/pipeline_schedules`, { description: "gmod: what isn't landing", ref: main, cron: '17 * * * *', active: true });
      if (r.ok) step('schedule', 'done', "hourly look at what isn't landing scheduled");
      else step('schedule', 'failed', `couldn't schedule the hourly look (${r.status}): ${JSON.stringify(r.json)}`);
    }
  }

  step('plan', governed ? 'skipped' : 'done', governed ? `a plan is already on ${main}` : `a starter ${PLAN} (no jobs yet) goes in setup's ${gitlab ? 'merge' : 'pull'} request`);
  if (!Object.keys(changed).length) {
    step('pr', 'skipped', `the ${gitlab ? 'component' : 'workflow'} (gmod ${ref}) and ${PROTECT} are already on ${main}`);
  } else {
    const opened = await governancePr(root, {
      main,
      url,
      branch: 'gmod/setup',
      token,
      files: changed,
      message: `ci: gmod ${ref}, and what ${main} requires\n\nWritten by gmod setup.${managedHere ? ' Managed mode on, as the person decided.' : ''}\n${managedHere ? decidedBy(root, via) + '\n' : ''}`,
    });
    pr = { url: opened.url };
    step('pr', 'done', `governance ${gitlab ? 'merge' : 'pull'} request: ${opened.url} (${Object.keys(changed).join(', ')})`);
    if (wait) {
      const w = await waitToLand(opened.url, { forge, token });
      if (w.landed) step('land', 'done', `it landed by itself in ${w.seconds}s: gate, review and landing work`);
      else step('land', 'failed', `it hasn't landed: ${w.why}. Its checks say why: ${opened.url}`);
    }
  }
  if (!managed) step('managed', 'skipped', 'managed mode stays as it is (--managed turns it on)');
  else if (managedHere) step('managed', changed[MANAGED] ? 'done' : 'skipped', changed[MANAGED] ? `managed mode on, in setup's ${gitlab ? 'merge' : 'pull'} request` : 'managed mode is already on');
  else {
    const r = decideOnMain(root, dir => setManaged(dir, true, { via }), (_, commit) => `gmod/managed-on-${commit}`);
    if (r.unchanged) step('managed', 'skipped', 'managed mode is already on');
    else {
      const d = await publishDecision(root, { branch: r.branch, commit: r.sha, url, main, forge, token });
      step('managed', 'done', `managed mode on, as its own decision: ${d.url}`);
    }
  }

  const secret = reviewerSecret(reviewer);
  if (agents && !gitlab && !gitea) {
    const list = gh(['secret', 'list', '--repo', `${forge.owner}/${forge.repo}`, '--json', 'name', '-q', '.[].name']);
    if (!(list.ok && list.out.split('\n').includes('GMOD_AGENT_KEY'))) step('agent-key', 'skipped', `agents in CI need GMOD_AGENT_KEY, an Anthropic API key from console.anthropic.com: gh secret set GMOD_AGENT_KEY --repo ${forge.owner}/${forge.repo}`, { leave: `add GMOD_AGENT_KEY (an Anthropic API key) as a repository secret: gh secret set GMOD_AGENT_KEY --repo ${forge.owner}/${forge.repo}` });
    const repo = `${forge.owner}/${forge.repo}`;
    if (actionsPrs(repo) !== true) {
      const set = gh(['api', '-X', 'PUT', `repos/${repo}/actions/permissions/workflow`, '-F', 'can_approve_pull_request_reviews=true', '-f', 'default_workflow_permissions=read']);
      if (set.ok) step('actions-prs', 'done', 'Actions may open pull requests now, so agents in CI can finish their jobs');
      else step('actions-prs', 'skipped', `agents in CI can't open pull requests until Actions may: ${ACTIONS_PRS_FIX(repo)}`, { leave: `let Actions open pull requests: ${ACTIONS_PRS_FIX(repo)}` });
    }
  }
  if (secret && !gitlab && !gitea) {
    const list = gh(['secret', 'list', '--repo', `${forge.owner}/${forge.repo}`, '--json', 'name', '-q', '.[].name']);
    if (!(list.ok && list.out.split('\n').includes(secret))) step('reviewer-key', 'skipped', `the reviewer's key isn't set yet: gh secret set ${secret} --repo ${forge.owner}/${forge.repo}`, { leave: `add ${secret} as a repository secret: gh secret set ${secret} --repo ${forge.owner}/${forge.repo}` });
  }
  return result();
}

// ---------- upgrade ----------

export async function upgrade(root, { main = 'main', url, to, candidates = false } = {}) {
  const forge = detectForge(root, { url });
  supported(forge, 'gmod ci upgrade');
  git(['fetch', '-q', 'origin', main], { cwd: root, allow: true });
  if (forge.kind === 'gitea') {
    const token = giteaLogin(forge);
    const action = giteaAction(root, forge);
    const wf = show(root, `origin/${main}`, GITEA_WORKFLOW).out;
    const current = wf.match(giteaPinRe(action))?.[1];
    if (!current) throw new GmodError(`no gmod in ${GITEA_WORKFLOW} on ${main}: gmod setup`);
    to ??= await giteaLatest(forge, token, action, { candidates });
    if (!to) throw new GmodError(`couldn't read gmod's releases from ${action}`);
    if (to === current || (parse(current) && !newer(to, current))) return { forge, current, to, upToDate: true };
    const text = wf.replace(giteaPinRe(action), m => m.replace(/ref: \S+$/, `ref: ${to}`));
    const pr = await governancePr(root, { main, url, token, branch: 'gmod/ci-upgrade', files: { [GITEA_WORKFLOW]: text.endsWith('\n') ? text : text + '\n' }, message: `ci: gmod ${to} (was ${current})\n\nWritten by gmod ci upgrade.\n` });
    return { forge, current, to, pr };
  }
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

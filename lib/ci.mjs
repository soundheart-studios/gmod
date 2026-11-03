// gmod ci: put the gate and the reviewer into a repository's CI, protect
// main so nothing merges unproven, and check it's all in place.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GmodError, PLAN, git, isCiFile, planFromDisk, protectSpec } from './core.mjs';
import { adrDir } from './adr.mjs';

// ---------- the forge, from origin ----------

export function detectForge(root, { url } = {}) {
  const origin = git(['remote', 'get-url', 'origin'], { cwd: root, allow: true }).out;
  if (!origin) throw new GmodError('no origin remote: gmod ci needs to know the forge');
  const m =
    origin.match(/^[\w.-]+@([^:]+):(?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?$/) ?? // git@host:owner/repo
    origin.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?$/) ??
    origin.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(?:.*\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new GmodError(`can't read the forge from origin ${origin}`);
  const [, hostPort, owner, repo] = m;
  let host = hostPort.replace(/:\d+$/, '');
  // Over ssh, the host may be an alias from ~/.ssh/config (e.g. github-2 for
  // a second GitHub key): ssh says what it really connects to.
  if (!/^https?:/.test(origin) && host !== 'github.com') {
    const config = process.env.GMOD_SSH_CONFIG ? ['-F', process.env.GMOD_SSH_CONFIG] : [];
    const real = spawnSync('ssh', [...config, '-G', host], { encoding: 'utf8', timeout: 5000 }).stdout?.match(/^hostname (\S+)$/m)?.[1];
    if (real === 'github.com') host = real;
  }
  if (host === 'github.com') return { kind: 'github', host, owner, repo, web: 'https://github.com', api: 'https://api.github.com' };
  // A Gitea: its web address is origin's when origin is http(s); over ssh it
  // can't be told, so --url says it, or git config once for every repository
  // on that host: git config --global gmod.<host>.url http://host:port
  url ??= git(['config', '--get', `gmod.${host}.url`], { cwd: root, allow: true }).out || undefined;
  const web = (url ?? (/^https?:/.test(origin) ? origin.match(/^(https?:\/\/[^/]+)/)[1].replace(/\/\/[^@/]+@/, '//') : null))?.replace(/\/$/, '');
  return { kind: 'gitea', host, owner, repo, web, api: web ? `${web}/api/v1` : null };
}

// ---------- the workflow ----------
//
// gmod:     { repo, ref, token? }  checked out next to the code, or
//           { path }               already on a self-hosted runner
// reviewer: { kind: 'claude' } | { kind: 'local', url, model? } | { kind: 'none' }

export function workflow({ forge, runsOn, gmod, reviewer = { kind: 'none' }, blocking = false, main = 'main', setup = '' }) {
  const hosted = forge === 'github' && !runsOn;
  const on = runsOn ?? 'ubuntu-latest';
  const home = gmod.path ? gmod.path : '.gmod-tool';
  const checkout = [`      - uses: actions/checkout@v4`, `        with: { fetch-depth: 0 }`];
  const tool = gmod.path
    ? []
    : [`      - uses: actions/checkout@v4`, `        with: { repository: ${gmod.repo}, ref: ${gmod.ref ?? 'main'}, path: .gmod-tool${gmod.token ? `, token: \${{ secrets.${gmod.token} }}` : ''} }`];
  const node = hosted ? [`      - uses: actions/setup-node@v4`, `        with: { node-version: 22 }`] : [];
  // What the repository's own checks need first (its packages, a toolchain):
  // the gate runs those checks, and the review reads the same tree.
  const deps = String(setup).trim()
    ? [`      - name: Install project dependencies`, `        run: |`, ...String(setup).trim().split('\n').map(l => `          ${l}`)]
    : [];
  const prEnv = [
    `        env:`,
    `          BASE: \${{ github.base_ref }}`,
    `          BRANCH: \${{ github.head_ref }}`,
    `          TITLE: \${{ github.event.pull_request.title }}`,
    // The pull request's own base: live main may already hold it by the time
    // a later job runs (it merged), and then there'd be nothing to compare.
    `          BASE_SHA: \${{ github.event.pull_request.base.sha }}`,
  ];
  const post = marker => [
    `      - name: Post it on the pull request`,
    `        if: always()`,
    `        run: node "$GMOD_HOME/ci/comment.mjs" --marker ${marker} --file ${marker === 'gmod-gate' ? 'gate' : 'review'}.md`,
    `        env:`,
    `          GMOD_PR: \${{ github.event.pull_request.number }}`,
    `          GMOD_TOKEN: \${{ github.token }}`,
  ];
  const perms = forge === 'github' ? [`    permissions: { contents: read, pull-requests: write, issues: write }`] : [];

  const env = [`env:`, `  GMOD_HOME: ${home}`];
  if (reviewer.kind === 'local') {
    env.push(`  GMOD_REVIEW_URL: ${reviewer.url}`);
    if (reviewer.model) env.push(`  GMOD_REVIEW_MODEL: ${reviewer.model}`);
  }
  if (reviewer.kind !== 'none' && !blocking) env.push(`  GMOD_REVIEW_MODE: comment`);

  const lines = [
    `# gmod: the gate on every pull request${reviewer.kind === 'none' ? '' : ', then an AI review'}, and claims let go`,
    `# once their job is on ${main}. Written by \`gmod ci init\`; \`gmod ci protect\` makes`,
    `# the gate required.`,
    `name: gmod`,
    `on:`,
    `  pull_request:`,
    `    types: [opened, synchronize, reopened, edited, labeled, unlabeled]`,
    `  push:`,
    `    branches: [${main}]`,
    // Hourly: what isn't landing (a failed job left alone, checks that never
    // finished, an old claim with no pull request) gets a "gmod stuck" issue.
    `  schedule:`,
    `    - cron: '17 * * * *'`,
    ``,
    ...env,
    ``,
    `jobs:`,
    `  gate:`,
    `    if: github.event_name == 'pull_request'`,
    `    runs-on: ${on}`,
    ...perms,
    `    steps:`,
    ...checkout,
    ...tool,
    ...node,
    ...deps,
    `      - name: The deterministic gate`,
    `        run: |`,
    `          git fetch -q origin '+refs/gmod/claims/*:refs/gmod/claims/*' || true`,
    `          node "$GMOD_HOME/bin/gmod.mjs" verify --base "\${BASE_SHA:-origin/$BASE}" --head HEAD --branch "$BRANCH" --title "$TITLE" --report gate.md`,
    ...prEnv,
    // To hold main's live protection to .gmod/protect.json: reading it needs
    // a person's token (CI's own can't); without one the gate refuses.
    `          GMOD_TOKEN: \${{ secrets.GMOD_FORGE_TOKEN }}`,
    ...post('gmod-gate'),
  ];
  if (reviewer.kind !== 'none') {
    lines.push(
      ``,
      `  review:`,
      `    needs: gate`,
      // Pull requests from forks get no secrets: the review would only skip.
      `    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository`,
      `    runs-on: ${on}`,
      ...perms,
      `    steps:`,
      ...checkout,
      ...tool,
      ...node,
      ...deps,
      ...(reviewer.kind === 'claude' ? [`      - run: npm install --prefix "$GMOD_HOME" --omit=dev --no-audit --no-fund`] : []),
      `      - name: The AI review${blocking ? '' : ' (advice only)'}`,
      `        run: node "$GMOD_HOME/ci/review.mjs" --base "\${BASE_SHA:-origin/$BASE}" --head HEAD --branch "$BRANCH" --title "$TITLE" --report review.md`,
      ...prEnv,
      ...(reviewer.kind === 'claude' ? [`          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}`] : []),
      ...(blocking ? [`          GMOD_REVIEW_OVERRIDE: \${{ contains(github.event.pull_request.labels.*.name, 'gmod-override') && '1' || '0' }}`] : []),
      ...post('gmod-review'),
    );
  }
  lines.push(
    ``,
    `  sweep:`,
    `    if: github.event_name == 'push' || github.event_name == 'schedule'`,
    `    runs-on: ${on}`,
    ...(forge === 'github' ? [`    permissions: { contents: write }`] : []),
    `    steps:`,
    ...checkout,
    ...tool,
    ...node,
    `      - name: Let go of claims on finished jobs`,
    `        run: node "$GMOD_HOME/bin/gmod.mjs" sweep`,
    // What just landed passed what main requires; the other job branches
    // take it in, so their checks run again and they land in turn.
    `      - name: Check what landed, bring the open jobs up to date, report what isn't landing`,
    `        run: node "$GMOD_HOME/ci/after-merge.mjs"`,
    `        env:`,
    `          GMOD_TOKEN: \${{ github.token }}`,
    // Updates made with CI's own token start no checks (the forge won't let
    // a workflow trigger itself): a person's token, kept as a secret, does.
    `          GMOD_FORGE_TOKEN: \${{ secrets.GMOD_FORGE_TOKEN }}`,
    `          GMOD_SHA: \${{ github.sha }}`,
  );
  return lines.join('\n') + '\n';
}

// ---------- init ----------

export function ciInit(root, opts) {
  const forge = detectForge(root, { url: opts.url });
  const dir = forge.kind === 'github' ? '.github' : '.gitea';
  const files = { [`${dir}/workflows/gmod.yml`]: workflow({ ...opts, forge: forge.kind }) };
  // The plan and the workflow both belong to the owners: a pull request runs
  // its own copy of the workflow, so it could weaken its own gate.
  if (opts.owners?.length) files[`${dir}/CODEOWNERS`] = `/.gmod/ ${opts.owners.join(' ')}\n/${dir}/ ${opts.owners.join(' ')}\n`;
  for (const f of Object.keys(files)) if (existsSync(join(root, f)) && !opts.force) throw new GmodError(`${f} already exists: use --force to replace it`);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return { forge, files: Object.keys(files) };
}

// A Gitea token: --token-file, else GITEA_TOKEN, else one file for every
// repository: ~/.config/gmod/gitea-token (a personal token is the person's,
// not one repository's).
export const TOKEN_FILE = join(homedir(), '.config', 'gmod', 'gitea-token');
export function giteaToken({ file, env = process.env, fallback = TOKEN_FILE } = {}) {
  if (file) return readFileSync(file, 'utf8').trim();
  if (env.GITEA_TOKEN) return env.GITEA_TOKEN;
  return fallback && existsSync(fallback) ? readFileSync(fallback, 'utf8').trim() || undefined : undefined;
}

// ---------- protect: nothing merges unproven ----------

// Exact names, never a pattern: Gitea also posts a skipped "gmod / gate
// (push)" on a branch's commits, and a pattern that matches it lets a pull
// request merge before its real gate has run (a skipped status passes).
const GATE = { gitea: 'gmod / gate (pull_request)', github: 'gate' };

async function giteaApi(forge, token, method, path, body) {
  if (!forge.api) throw new GmodError("this Gitea's web address isn't known from origin: pass --url http://host:port");
  const res = await fetch(`${forge.api}${path}`, {
    method,
    headers: { authorization: `token ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Some answers (a 404 page) aren't JSON: callers read ok and status first.
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { text };
  }
  return { status: res.status, ok: res.ok, json };
}

function gh(args, input) {
  // GMOD_GH: another gh, for tests.
  const r = spawnSync(process.env.GMOD_GH || 'gh', args, { input, encoding: 'utf8' });
  if (r.error) throw new GmodError('gh (the GitHub CLI) is needed for GitHub: https://cli.github.com');
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

const REVIEW = { gitea: 'gmod / review (pull_request)', github: 'review' };

export async function ciProtect(root, { url, token, main = 'main', codeOwners = false, requireReview } = {}) {
  const forge = detectForge(root, { url });
  // What the repository declares wins over the flag's default.
  requireReview ??= protectSpec(root, `origin/${main}`)?.require.includes('review') ?? protectSpec(root)?.require.includes('review') ?? false;
  if (forge.kind === 'github') {
    const body = {
      required_status_checks: { strict: true, contexts: [GATE.github, ...(requireReview ? [REVIEW.github] : [])] },
      enforce_admins: false,
      required_pull_request_reviews: { required_approving_review_count: 0, require_code_owner_reviews: codeOwners },
      restrictions: null,
    };
    const r = gh(['api', '-X', 'PUT', `repos/${forge.owner}/${forge.repo}/branches/${main}/protection`, '--input', '-'], JSON.stringify(body));
    if (!r.ok) throw new GmodError(`GitHub refused the protection: ${r.err.trim()}`);
    return { forge, rule: body };
  }
  if (!token) throw new GmodError(`a Gitea token is needed: ${TOKEN_FILE}, --token-file <file> or GITEA_TOKEN`);
  const rule = {
    rule_name: main,
    enable_push: false,
    enable_status_check: true,
    status_check_contexts: [GATE.gitea, ...(requireReview ? [REVIEW.gitea] : [])],
    block_on_outdated_branch: true,
    required_approvals: 0,
    ...(codeOwners ? { block_on_official_review_requests: false } : {}),
  };
  const base = `/repos/${forge.owner}/${forge.repo}/branch_protections`;
  const now = await giteaApi(forge, token, 'GET', `${base}/${main}`);
  const r = now.ok ? await giteaApi(forge, token, 'PATCH', `${base}/${main}`, rule) : await giteaApi(forge, token, 'POST', base, rule);
  if (!r.ok) throw new GmodError(`Gitea refused the protection (${r.status}): ${JSON.stringify(r.json)}`);
  return { forge, rule: r.json };
}

// Does main's live protection hold what the repository declares? A finding
// for the gate: { ok, msg }, or null when nothing is declared.
export async function protectionMatches(root, { spec, url, token, main = 'main' }) {
  if (!spec) return null;
  const forge = detectForge(root, { url });
  if (forge.kind !== 'gitea') return { ok: true, info: true, msg: `${main}'s protection on ${forge.kind} isn't compared yet` };
  if (!token) return { ok: false, msg: `no token to read ${main}'s protection, so it can't be held to .gmod/protect.json` };
  const r = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/branch_protections/${main}`).catch(e => ({ ok: false, status: e.message }));
  if (!r.ok) return { ok: false, msg: `couldn't read ${main}'s protection (${r.status}), so it can't be held to .gmod/protect.json` };
  const live = r.json;
  const contexts = live.enable_status_check ? live.status_check_contexts ?? [] : [];
  const missing = [];
  for (const need of spec.require) if (!contexts.includes(`gmod / ${need} (pull_request)`)) missing.push(`the ${need} isn't required by its exact name`);
  // A pattern also matches the skipped "(push)" statuses, which pass.
  const patterns = contexts.filter(c => c.includes('*'));
  if (patterns.length) missing.push(`${patterns.join(', ')} ${patterns.length === 1 ? 'is a pattern' : 'are patterns'} a skipped status satisfies`);
  if (spec.up_to_date && !live.block_on_outdated_branch) missing.push("branches needn't be up to date");
  if (live.enable_push) missing.push('direct pushes are allowed');
  return missing.length
    ? { ok: false, msg: `${main}'s protection is weaker than .gmod/protect.json: ${missing.join(', ')} (gmod ci protect puts it back)` }
    : { ok: true, msg: `${main}'s protection holds .gmod/protect.json (${spec.require.join(' and ')} required)` };
}

// ---------- check: is it all in place? ----------

export async function ciCheck(root, { url, token, main = 'main' } = {}) {
  const forge = detectForge(root, { url });
  const findings = [];
  const pass = msg => findings.push({ ok: true, msg });
  const fail = msg => findings.push({ ok: false, msg });
  const file = forge.kind === 'github' ? '.github/workflows/gmod.yml' : '.gitea/workflows/gmod.yml';
  const yml = existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null;
  yml ? pass(`the workflow is in ${file}`) : fail(`no workflow at ${file}: gmod ci init`);
  const runsOn = yml?.match(/runs-on: (.+)/)?.[1].trim();
  const reviewUrl = yml?.match(/GMOD_REVIEW_URL: (.+)/)?.[1].trim();

  if (forge.kind === 'github') {
    const r = gh(['api', `repos/${forge.owner}/${forge.repo}/branches/${main}/protection`]);
    const p = r.ok ? JSON.parse(r.out) : null;
    p?.required_status_checks?.contexts?.includes(GATE.github) && p.required_status_checks.strict
      ? pass(`${main} requires the gate and up-to-date branches`)
      : fail(`${main} doesn't require the gate on up-to-date branches: gmod ci protect`);
    if (runsOn && runsOn !== 'ubuntu-latest') fail(`runs-on ${runsOn}: check that runner exists in the repository's settings`);
  } else if (!token) {
    fail(`no Gitea token, so protection and runners went unchecked: put one in ${TOKEN_FILE}`);
  } else {
    const rule = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/branch_protections/${main}`);
    const p = rule.ok ? rule.json : null;
    p?.enable_status_check && (p.status_check_contexts ?? []).includes(GATE.gitea) && !(p.status_check_contexts ?? []).some(c => c.includes('*')) && p.block_on_outdated_branch
      ? pass(`${main} requires the gate and up-to-date branches`)
      : fail(`${main} doesn't require the gate on up-to-date branches: gmod ci protect`);
    if (p && p.enable_push !== false) fail(`${main} still takes direct pushes: gmod ci protect`);
    if (runsOn) {
      // A runner serves a repository, its owner, or the whole instance: ask
      // each in turn (the instance's list needs an admin's token).
      const scopes = [
        ['', `/repos/${forge.owner}/${forge.repo}/actions/runners`],
        ["the owner's", `/orgs/${forge.owner}/actions/runners`],
        ['yours', '/user/actions/runners'],
        ["the instance's", '/admin/actions/runners'],
      ];
      let found = null;
      let listed = false;
      const unseen = [];
      for (const [scope, path] of scopes) {
        const r = await giteaApi(forge, token, 'GET', path).catch(() => ({ ok: false }));
        if (!r.ok) {
          unseen.push(scope || "the repository's");
          continue;
        }
        listed = true;
        const match = (r.json?.runners ?? []).find(x => (x.labels ?? []).some(l => (l.name ?? l) === runsOn));
        if (match) {
          found = { ...match, scope };
          break;
        }
      }
      if (found) pass(`runner ${found.name} (${found.status}) has the label ${runsOn}${found.scope ? ` (${found.scope})` : ''}`);
      else if (!listed) fail(`couldn't list runners: check one has the label ${runsOn}`);
      else if (unseen.includes("the instance's")) fail(`no runner with the label ${runsOn} in ${scopes.map(([s]) => s || "the repository's").filter(s => !unseen.includes(s)).join(', ')}; the instance's runners need a token with read:admin to see: check there`);
      else fail(`no runner with the label ${runsOn}: register one (gitea-runner register --labels ${runsOn}:host)`);
    }
  }

  // After a merge, CI brings the other job branches up to date; only a
  // person's token makes the forge run their checks again.
  if (yml?.includes('after-merge.mjs') && forge.kind === 'gitea' && token) {
    const r = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/actions/secrets`).catch(() => ({ ok: false }));
    if (r.ok) (r.json ?? []).some(x => x.name === 'GMOD_FORGE_TOKEN')
      ? pass('the GMOD_FORGE_TOKEN secret is set: the gate reads main\'s protection, and job branches brought up to date are checked again')
      : fail('no GMOD_FORGE_TOKEN secret: the gate can\'t read main\'s protection, and job branches CI brings up to date wait unchecked: gmod ci forge-token');
  }

  if (reviewUrl) {
    try {
      const r = await fetch(`${reviewUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(5000) });
      r.ok ? pass(`the reviewer answers at ${reviewUrl}`) : fail(`the reviewer at ${reviewUrl} answered ${r.status}`);
    } catch (e) {
      fail(`the reviewer at ${reviewUrl} doesn't answer from here (${e.cause?.code ?? e.message}); the runner may still reach it`);
    }
  }
  return { ok: findings.every(f => f.ok), forge, findings };
}

// ---------- pr: hand a job's branch over ----------
//
// The branch must be pushed as it is: the pull request shows what origin has.
// Titled by the job's commit, described by its goal, brief and journal. Asked
// again, it answers with the one already open.
// What a branch changes, as the gate sorts it: a job's work, or a plan, ADR
// or CI change that waits for a person.
export function prKind(root, { main = 'main', branch }) {
  const changed = git(['diff', '--name-only', `origin/${main}...${branch}`], { cwd: root }).split('\n').filter(Boolean);
  const adr = `${adrDir(planFromDisk(root) ?? {})}/`;
  if (changed.includes(PLAN)) return 'plan';
  if (changed.some(f => f.startsWith(adr))) return 'adr';
  if (changed.some(isCiFile)) return 'ci';
  return 'job';
}

export async function openPr(root, { url, token, main = 'main', job, goal, brief, branch, auto = false, forge = detectForge(root, { url }) } = {}) {
  branch ??= git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  if (!branch || branch === 'HEAD' || branch === main) throw new GmodError(`on ${branch || 'no branch'}: check out the job's branch, or --branch <name>`);
  const local = git(['rev-parse', branch], { cwd: root });
  const remote = git(['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: root, allow: true }).out.split(/\s/)[0];
  if (remote !== local) throw new GmodError(`origin doesn't have ${branch} as it is here: git push -u origin ${branch}`);
  const subjects = git(['log', '--format=%s', `origin/${main}..${branch}`], { cwd: root, allow: true }).out.split('\n').filter(Boolean);
  // A plan, ADR or CI change lands on green too: the gate checks it travels
  // alone, and the review asks whether it weakens what is checked. It names
  // no job: its title is its commit's.
  const kind = prKind(root, { main, branch });
  if (kind !== 'job') job = null;
  else job ??= branch.startsWith('gmod/') ? branch.slice(5) : subjects.at(-1)?.split(':')[0];
  const title = kind === 'job' ? subjects.filter(x => x.startsWith(`${job}:`)).at(-1) : subjects.at(-1);
  if (!title) throw new GmodError(kind === 'job' ? `no commit on ${branch} starts with "${job}:": commit the job's work first` : `nothing committed on ${branch}`);
  const jf = job ? join(root, '.gmod', 'journal', `${job}.md`) : '';
  const body = [goal && `**${job}**: ${goal}`, brief, existsSync(jf) && `### Journal\n\n${readFileSync(jf, 'utf8').replace(/^# .*\n+/, '')}`].filter(Boolean).join('\n\n');

  if (forge.kind === 'github') {
    const made = gh(['pr', 'create', '--base', main, '--head', branch, '--title', title, '--body-file', '-'], body);
    const r = made.ok ? made : gh(['pr', 'view', branch, '--json', 'url', '-q', '.url']);
    if (!r.ok) throw new GmodError(`GitHub refused the pull request: ${made.err.trim()}`);
    // Landing on green is the gmod action's: it merges once gate and review
    // have passed on this very commit. Never `gh pr merge --auto` from here:
    // on a repository with no required checks GitHub merges at once, before
    // anything has run.
    return { forge, branch, title, kind, auto, landing: auto ? 'the gmod action' : null, url: r.out.trim().split('\n').at(-1), existed: !made.ok };
  }
  if (!token) throw new GmodError(`a Gitea token is needed: ${TOKEN_FILE}, --token-file <file> or GITEA_TOKEN`);
  const base = `/repos/${forge.owner}/${forge.repo}/pulls`;
  const made = await giteaApi(forge, token, 'POST', base, { head: branch, base: main, title, body });
  let pr = made.ok ? made.json : null;
  if (!pr) {
    const open = await giteaApi(forge, token, 'GET', `${base}?state=open&limit=50`);
    pr = open.ok && (open.json ?? []).find(p => p.head?.ref === branch);
    if (!pr) throw new GmodError(`Gitea refused the pull request (${made.status}): ${JSON.stringify(made.json)}`);
  }
  if (auto) {
    // Gitea merges it itself once main's required checks pass on it.
    const m = await giteaApi(forge, token, 'POST', `${base}/${pr.number}/merge`, { Do: 'merge', merge_when_checks_succeed: true });
    if (!m.ok) throw new GmodError(`Gitea wouldn't merge it on green (${m.status}): ${JSON.stringify(m.json)}`);
  }
  return { forge, branch, title: pr.title, kind, auto, number: pr.number, url: pr.html_url, existed: !made.ok };
}

// ---------- pr --status: what the checks said ----------
export async function prStatus(root, { url, token, branch } = {}) {
  const forge = detectForge(root, { url });
  if (forge.kind !== 'gitea') throw new GmodError('gmod pr --status reads Gitea for now: on GitHub, gh pr checks');
  if (!token) throw new GmodError(`a Gitea token is needed: ${TOKEN_FILE}, --token-file <file> or GITEA_TOKEN`);
  branch ??= git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const base = `/repos/${forge.owner}/${forge.repo}`;
  const list = [];
  for (const state of ['open', 'closed']) {
    const r = await giteaApi(forge, token, 'GET', `${base}/pulls?state=${state}&limit=50`);
    if (r.ok) list.push(...(r.json ?? []));
  }
  const pr = list.filter(p => p.head?.ref === branch).sort((a, b) => b.number - a.number)[0];
  if (!pr) throw new GmodError(`no pull request from ${branch}`);
  const st = await giteaApi(forge, token, 'GET', `${base}/commits/${pr.head.sha}/status`);
  const latest = new Map();
  for (const x of (st.ok ? st.json?.statuses ?? [] : []).slice().reverse()) latest.set(x.context, x.status);
  const checks = [...latest].filter(([c]) => c.endsWith('(pull_request)')).map(([context, state]) => ({ context: context.replace(/ \(pull_request\)$/, ''), state }));
  const c = await giteaApi(forge, token, 'GET', `${base}/issues/${pr.number}/comments`);
  const reports = c.ok ? (c.json ?? []).filter(x => /^<!-- gmod-(gate|review) -->/.test(x.body ?? '')).map(x => x.body.replace(/^<!-- [^>]+ -->\n/, '')) : null;
  return {
    number: pr.number, url: pr.html_url, state: pr.merged ? 'merged' : pr.state, checks, reports,
    note: reports ? null : `the reports need a token with read:issue (${c.status})`,
  };
}

// ---------- forge-token: what CI's own token can't do ----------
//
// Keeps the person's token as the repository's GMOD_FORGE_TOKEN secret: the
// gate reads main's protection with it, and after a merge the job branches
// brought up to date with it are checked again (the forge starts no checks
// for what CI's own token pushes).
export async function ciForgeToken(root, { url, token } = {}) {
  const forge = detectForge(root, { url });
  if (forge.kind !== 'gitea') throw new GmodError('forge-token is for Gitea; on GitHub, a repository secret set with gh secret set');
  if (!token) throw new GmodError(`a Gitea token is needed: ${TOKEN_FILE}, --token-file <file> or GITEA_TOKEN`);
  const r = await giteaApi(forge, token, 'PUT', `/repos/${forge.owner}/${forge.repo}/actions/secrets/GMOD_FORGE_TOKEN`, { data: token });
  if (!r.ok) throw new GmodError(`Gitea refused the secret (${r.status}): ${JSON.stringify(r.json)}`);
  // Job pull requests that waited for it: brought up to date as the person,
  // their checks run again, and they land in turn.
  const updated = [];
  const open = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/pulls?state=open&limit=50`);
  for (const pr of open.ok ? open.json ?? [] : []) {
    if (!pr.head?.ref?.startsWith('gmod/')) continue;
    const u = await giteaApi(forge, token, 'POST', `/repos/${forge.owner}/${forge.repo}/pulls/${pr.number}/update?style=merge`);
    if (u.ok) updated.push(pr.number);
  }
  return { forge, updated };
}

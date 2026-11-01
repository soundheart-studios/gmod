// gmod ci: put the gate and the reviewer into a repository's CI, protect
// main so nothing merges unproven, and check it's all in place.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GmodError, git } from './core.mjs';

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
  const host = hostPort.replace(/:\d+$/, '');
  if (host === 'github.com') return { kind: 'github', host, owner, repo, web: 'https://github.com', api: 'https://api.github.com' };
  // A Gitea: its web address is origin's when origin is http(s); over ssh it
  // can't be told, so --url says it.
  const web = (url ?? (/^https?:/.test(origin) ? origin.match(/^(https?:\/\/[^/]+)/)[1].replace(/\/\/[^@/]+@/, '//') : null))?.replace(/\/$/, '');
  return { kind: 'gitea', host, owner, repo, web, api: web ? `${web}/api/v1` : null };
}

// ---------- the workflow ----------
//
// gmod:     { repo, ref, token? }  checked out next to the code, or
//           { path }               already on a self-hosted runner
// reviewer: { kind: 'claude' } | { kind: 'local', url, model? } | { kind: 'none' }

export function workflow({ forge, runsOn, gmod, reviewer = { kind: 'none' }, blocking = false, main = 'main' }) {
  const hosted = forge === 'github' && !runsOn;
  const on = runsOn ?? 'ubuntu-latest';
  const home = gmod.path ? gmod.path : '.gmod-tool';
  const checkout = [`      - uses: actions/checkout@v4`, `        with: { fetch-depth: 0 }`];
  const tool = gmod.path
    ? []
    : [`      - uses: actions/checkout@v4`, `        with: { repository: ${gmod.repo}, ref: ${gmod.ref ?? 'main'}, path: .gmod-tool${gmod.token ? `, token: \${{ secrets.${gmod.token} }}` : ''} }`];
  const node = hosted ? [`      - uses: actions/setup-node@v4`, `        with: { node-version: 22 }`] : [];
  const prEnv = [
    `        env:`,
    `          BASE: \${{ github.base_ref }}`,
    `          BRANCH: \${{ github.head_ref }}`,
    `          TITLE: \${{ github.event.pull_request.title }}`,
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
    `      - name: The deterministic gate`,
    `        run: |`,
    `          git fetch -q origin '+refs/gmod/claims/*:refs/gmod/claims/*' || true`,
    `          node "$GMOD_HOME/bin/gmod.mjs" verify --base "origin/$BASE" --head HEAD --branch "$BRANCH" --title "$TITLE" --report gate.md`,
    ...prEnv,
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
      ...(reviewer.kind === 'claude' ? [`      - run: npm install --prefix "$GMOD_HOME" --omit=dev --no-audit --no-fund`] : []),
      `      - name: The AI review${blocking ? '' : ' (advice only)'}`,
      `        run: node "$GMOD_HOME/ci/review.mjs" --base "origin/$BASE" --head HEAD --branch "$BRANCH" --title "$TITLE" --report review.md`,
      ...prEnv,
      ...(reviewer.kind === 'claude' ? [`          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}`] : []),
      ...(blocking ? [`          GMOD_REVIEW_OVERRIDE: \${{ contains(github.event.pull_request.labels.*.name, 'gmod-override') && '1' || '0' }}`] : []),
      ...post('gmod-review'),
    );
  }
  lines.push(
    ``,
    `  sweep:`,
    `    if: github.event_name == 'push'`,
    `    runs-on: ${on}`,
    ...(forge === 'github' ? [`    permissions: { contents: write }`] : []),
    `    steps:`,
    ...checkout,
    ...tool,
    ...node,
    `      - name: Let go of claims on finished jobs`,
    `        run: node "$GMOD_HOME/bin/gmod.mjs" sweep`,
  );
  return lines.join('\n') + '\n';
}

// ---------- init ----------

export function ciInit(root, opts) {
  const forge = detectForge(root, { url: opts.url });
  const dir = forge.kind === 'github' ? '.github' : '.gitea';
  const files = { [`${dir}/workflows/gmod.yml`]: workflow({ ...opts, forge: forge.kind }) };
  if (opts.owners?.length) files[`${dir}/CODEOWNERS`] = `/.gmod/ ${opts.owners.join(' ')}\n`;
  for (const f of Object.keys(files)) if (existsSync(join(root, f)) && !opts.force) throw new GmodError(`${f} already exists: use --force to replace it`);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return { forge, files: Object.keys(files) };
}

// ---------- protect: nothing merges unproven ----------

const GATE = { gitea: 'gmod / gate*', github: 'gate' };

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
  const r = spawnSync('gh', args, { input, encoding: 'utf8' });
  if (r.error) throw new GmodError('gh (the GitHub CLI) is needed for GitHub: https://cli.github.com');
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

export async function ciProtect(root, { url, token, main = 'main', codeOwners = false } = {}) {
  const forge = detectForge(root, { url });
  if (forge.kind === 'github') {
    const body = {
      required_status_checks: { strict: true, contexts: [GATE.github] },
      enforce_admins: false,
      required_pull_request_reviews: { required_approving_review_count: 0, require_code_owner_reviews: codeOwners },
      restrictions: null,
    };
    const r = gh(['api', '-X', 'PUT', `repos/${forge.owner}/${forge.repo}/branches/${main}/protection`, '--input', '-'], JSON.stringify(body));
    if (!r.ok) throw new GmodError(`GitHub refused the protection: ${r.err.trim()}`);
    return { forge, rule: body };
  }
  if (!token) throw new GmodError('a Gitea token is needed: --token-file <file> (or GITEA_TOKEN)');
  const rule = {
    rule_name: main,
    enable_push: false,
    enable_status_check: true,
    status_check_contexts: [GATE.gitea],
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
    fail('no Gitea token, so protection and runners went unchecked: --token-file <file>');
  } else {
    const rule = await giteaApi(forge, token, 'GET', `/repos/${forge.owner}/${forge.repo}/branch_protections/${main}`);
    const p = rule.ok ? rule.json : null;
    p?.enable_status_check && (p.status_check_contexts ?? []).some(c => c.startsWith('gmod / gate')) && p.block_on_outdated_branch
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
      for (const [scope, path] of scopes) {
        const r = await giteaApi(forge, token, 'GET', path).catch(() => ({ ok: false }));
        if (!r.ok) continue;
        listed = true;
        const match = (r.json?.runners ?? []).find(x => (x.labels ?? []).some(l => (l.name ?? l) === runsOn));
        if (match) {
          found = { ...match, scope };
          break;
        }
      }
      if (found) pass(`runner ${found.name} (${found.status}) has the label ${runsOn}${found.scope ? ` (${found.scope})` : ''}`);
      else if (!listed) fail(`couldn't list runners: check one has the label ${runsOn}`);
      else fail(`no runner with the label ${runsOn}: register one (gitea-runner register --labels ${runsOn}:host)`);
    }
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

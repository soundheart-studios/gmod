// An agent in CI: Claude Code, headless, with gmod loaded, doing one job the
// way an agent at a keyboard does. The forge-specific parts (starting a run,
// finding the pull request it opened) stay with each forge's CI script.
import { spawnSync } from 'node:child_process';
import * as core from './core.mjs';

export const AGENT = { name: 'gmod agent', email: 'gmod-agent@users.noreply.github.com' };

export const PROMPT = [
  'You are an agent in CI, with no person watching. Do exactly one gmod job, start to finish, following /gmod:work "One job":',
  'mcp__gmod__next, mcp__gmod__claim it, read it with mcp__gmod__status, write its tests and mcp__gmod__check (red),',
  "make them pass and mcp__gmod__check (green), then mcp__gmod__commit. Stay inside the job's files.",
  'If a claim is taken, take the next ready job. If anything is refused or you cannot finish, say exactly why in one line and stop.',
].join(' ');

// Fixing an agent's own pull request whose checks failed, or doing what a
// maintainer asked for on it (@gmod): the reports, or the request, are the
// brief. The job is picked up where its branch left it.
export const FIX_TRIES = Number(process.env.GMOD_FIX_TRIES || 2);
export const FIX_MARKER = '<!-- gmod-fix -->';
export function fixPrompt({ job, number, reports = [], request }) {
  return [
    `You are an agent in CI, with no person watching. Job ${job} has a pull request, #${number}, that ${request ? 'a maintainer asked you to change' : "didn't pass its checks"}.`,
    `mcp__gmod__claim ${job}: it picks the job up on its branch, with red already recorded from the proof. Read the job with mcp__gmod__status.`,
    request ? `What the maintainer asked:\n\n${request}\n` : `What the checks said:\n\n${reports.join('\n\n---\n\n')}\n`,
    "Change only the job's files to address it, mcp__gmod__check until it passes, then mcp__gmod__commit: the pull request takes the new commit.",
    'If what is asked needs files outside the job, or anything is refused, say exactly why in one line and stop.',
  ].join('\n\n');
}

// A Claude Code sign-in token (sk-ant-oat…) or an API key.
export const agentAuth = key => (key.startsWith('sk-ant-oat') ? { CLAUDE_CODE_OAUTH_TOKEN: key } : { ANTHROPIC_API_KEY: key });

// Ready jobs no agent should skip: not stuck (an open "gmod stuck" issue
// keeps agents off a job until a person closes it).
export function readyJobs(root, plan, stuck = new Set()) {
  return core.states(root, plan, { sync: true }).filter(j => j.state === 'ready' && !stuck.has(j.id));
}
// An agent's claims with no pull request open after GMOD_AGENT_STALE_MINUTES
// (60): its pull request was closed, or its run died. Long enough that a
// running agent, which opens its pull request only at the end, isn't one.
export function staleAgentClaims(root, openBranches, minutes = Number(process.env.GMOD_AGENT_STALE_MINUTES || 60)) {
  return Object.entries(core.claims(root))
    .filter(([id, c]) => c.by === AGENT.email && !openBranches.has(`gmod/${id}`) && Date.now() - Date.parse(c.at) > minutes * 60_000)
    .map(([id]) => id);
}

export const agentClaims = root => Object.entries(core.claims(root)).filter(([, c]) => c.by === AGENT.email).map(([id]) => id);

// Install Claude Code and run one agent in root. { ok, said, claimed: [jobs it took] }.
export function runAgent({ root, home, key, version = 'latest', turns = '60', env = {}, prompt = PROMPT }) {
  core.git(['config', 'user.name', AGENT.name], { cwd: root });
  core.git(['config', 'user.email', AGENT.email], { cwd: root });
  const before = new Set(agentClaims(root));
  const install = spawnSync('npm', ['install', '-g', '--no-audit', '--no-fund', `@anthropic-ai/claude-code@${version}`], { stdio: 'inherit' });
  if (install.status !== 0) return { ok: false, said: "Claude Code wouldn't install", claimed: [] };
  const r = spawnSync('claude', ['-p', prompt, '--plugin-dir', home, '--permission-mode', 'bypassPermissions', '--max-turns', String(turns)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    // A CI container runs as root: say it's a throwaway sandbox.
    env: { ...process.env, ...env, ...agentAuth(key), IS_SANDBOX: '1' },
  });
  const said = (r.stdout || '').trim();
  console.log(said);
  core.syncClaims(root);
  return { ok: r.status === 0, said, claimed: agentClaims(root).filter(id => !before.has(id)), head: core.git(['rev-parse', 'HEAD'], { cwd: root, allow: true }).out };
}

export function stuckBody(job, said, runUrl) {
  return `An agent in CI took ${job} and couldn't finish it.\n\nWhat it said:\n\n> ${said.split('\n').slice(-6).join('\n> ') || '(nothing)'}\n\nRun: ${runUrl}\n\nNo agent takes ${job} again while this issue is open. Close it to let one try again.`;
}

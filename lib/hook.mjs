// `gmod hook codex`: OpenAI Codex's command hook. Codex hands it one event as
// JSON on stdin (hook_event_name, cwd, tool_name, tool_input); a PreToolUse
// call it refuses is answered with a deny on stdout, anything else with
// nothing. The rules are the mod's (hooks/register.tsx), from lib/shell.mjs
// and lib/core.mjs, in the same order and the same words (ADR 0003).
// SessionStart, SubagentStart and PostToolUse add context instead, as the
// mod's prompt and notices do: the routine (lib/routine.mjs), the claim, and
// what gmod notice says after a step. An ungoverned repository hears nothing.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as core from './core.mjs';
import { CODEX_DECIDES, CODEX_FOR_SUBAGENTS, CODEX_ROUTINE } from './routine.mjs';
import { commitDirs, commitsAlone, decision, mergesPr, movesClaims, resolveDir, writesPlan, writesRecords } from './shell.mjs';

// Codex has no /gmod allow-plan: the plan is always refused here.
function bashRefusal(cmd, cwd) {
  if (governed(cwd)) {
    if (movesClaims(cmd)) return 'gmod: claims change only through mcp__gmod__claim and mcp__gmod__release';
    if (mergesPr(cmd)) return "gmod: pull requests merge through the forge once their checks pass (gmod pr --auto for a job); merging by hand is the person's call";
    const decides = decision(cmd);
    if (decides === 'plan') return "gmod: approving or rejecting the plan is the person's decision: they do it in the gmod pane or with /gmod approve";
    if (decides === 'managed') return "gmod: switching managed mode is the person's decision: they make it with gmod manage on|off at their own prompt";
    if (writesRecords(cmd)) return "gmod: gmod's own records change only through gmod";
    if (writesPlan(cmd)) return 'gmod: .gmod/plan.json changes only through a proposal the person approves (mcp__gmod__propose_job), or after /gmod allow-plan';
    if (!commitsAlone(cmd)) return 'gmod: a commit runs on its own: beside git commit, only cd and git that changes no file (add, status, diff, log, show). Run the rest first, then commit, so what is committed is what the gate saw';
  }
  // Each worktree a `git commit` commits in decides for itself (an
  // ungoverned one lets it through).
  for (const d of commitDirs(cmd)) {
    const dir = resolveDir(cwd, d, homedir());
    let r;
    try {
      r = core.gateCommit(core.repoRoot(dir));
    } catch (e) {
      r = { ok: false, reason: e.message };
    }
    if (!r.ok) return `gmod: ${r.reason}`;
  }
  return null;
}

function governed(cwd) {
  try {
    return existsSync(join(core.repoRoot(cwd), core.PLAN));
  } catch {
    return false;
  }
}

// The paths a patch touches: added, updated, deleted and moved-to files.
export function patchPaths(text) {
  return [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)].map(m => m[1]);
}

function patchRefusal(text, cwd) {
  for (const p of patchPaths(text)) {
    const r = core.guardFile(resolve(cwd, p), { cwd });
    if (!r.ok) return `gmod: ${r.reason}`;
  }
  return null;
}

// The answer to one event: a refusal's reason, or null to let it through.
export function answer(event) {
  if (event?.hook_event_name !== 'PreToolUse') return null;
  const cwd = event.cwd;
  if (typeof cwd !== 'string' || !cwd) throw new Error('the event has no cwd');
  const cmd = event.tool_input?.command;
  if (event.tool_name === 'Bash') {
    if (typeof cmd !== 'string') throw new Error('a Bash call without a command');
    return bashRefusal(cmd, cwd);
  }
  if (event.tool_name === 'apply_patch') {
    if (typeof cmd !== 'string') throw new Error('an apply_patch call without a patch');
    return patchRefusal(cmd, cwd);
  }
  return null;
}

// What the agent is told at the start of a session: the routine, then the
// claim held here (or the next ready job), then one line when something waits
// for the person. Kept short: Codex caps a hook's context.
export function sessionContext(cwd) {
  const s = core.status(core.repoRoot(cwd));
  const c = s.claim;
  const decisions = (c?.adrs ?? []).map(a => `- ADR ${a.id} (${a.title}):\n${a.rules.map(r => `  - ${r.level}: ${r.text}`).join('\n')}`).join('\n');
  const now = c
    ? `\nYou hold ${c.job}: ${c.goal}\nIts files: ${c.files.join(', ')}\nDone when:\n${c.done_when.map(x => `- ${x}`).join('\n')}${decisions ? `\nDecisions that bind this job (a "must" is never broken; to change one, draft a new ADR with mcp__gmod__adr_propose):\n${decisions}` : ''}`
    : `\nNo job is claimed${s.next ? `; the next ready one is ${s.next}` : ''}.`;
  const waiting = [
    ...(s.proposal ? [`a plan proposal (${s.proposal.summary || s.proposal.headline || 'no summary yet'})`] : []),
    ...(s.adrDrafts ?? []).map(d => `the decision "${d.title}"`),
  ];
  const line = waiting.length ? `\nWaiting for the person: ${waiting.join(', ')}; ${CODEX_DECIDES}.` : '';
  return CODEX_ROUTINE + now + line;
}

// The context one event adds, or null for none.
export function context(event) {
  const name = event?.hook_event_name;
  if (!['SessionStart', 'SubagentStart', 'PostToolUse'].includes(name)) return null;
  const cwd = event.cwd;
  if (typeof cwd !== 'string' || !cwd || !governed(cwd)) return null;
  if (name === 'SessionStart') return sessionContext(cwd);
  if (name === 'SubagentStart') return CODEX_FOR_SUBAGENTS.trim();
  return core.notice(cwd, { cwd }).trim() || null;
}

// Read stdin, answer, and say what Codex should do: 0 with a deny or nothing,
// 2 (with the reason on stderr) when the hook itself failed, so a tool call
// it couldn't judge is blocked, not waved through.
export function codex(input = readFileSync(0, 'utf8')) {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.stderr.write('gmod: its hook could not read the event; nothing ran\n');
    return 2;
  }
  try {
    const why = answer(event);
    if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }) + '\n');
    const said = context(event);
    if (said) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: said } }) + '\n');
    return 0;
  } catch (e) {
    if (event?.hook_event_name !== 'PreToolUse') return 0;
    process.stderr.write(`gmod: its hook failed (${String(e?.message ?? e).split('\n')[0]}); nothing ran\n`);
    return 2;
  }
}

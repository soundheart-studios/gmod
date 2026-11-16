// What an agent is told about gmod, one copy for every host: the Claude Code
// mod (hooks/register.tsx) puts ROUTINE in the prompt and requires
// FOR_SUBAGENTS in a subagent's; the Codex hook (lib/hook.mjs) adds the
// CODEX_ variants as context. Codex has no pane and no slash commands: the
// person decides in a terminal of their own (gmod watch, gmod decide).
//
// No imports: the mod's hook loads this module as it is.

export const ROUTINE = `This repository plans its work in .gmod/plan.json, and the gmod mod enforces it:
- Take work with mcp__gmod__next and mcp__gmod__claim. Change only the claimed job's files; edits elsewhere are refused. Keep the job's journal with mcp__gmod__note: intent, decisions, dead ends.
- Write or change the tests first, run mcp__gmod__check and see it fail (red). Then make it pass and run mcp__gmod__check again (green).
- Hand the work over with mcp__gmod__commit once it is green: it commits exactly what the passing check ran on as "<job>: …", pushes, and opens the pull request, which lands by itself once CI's checks pass. Don't run git commit yourself, and never merge a pull request. mcp__gmod__pr_status says how its checks went; fix what they found and commit again.
- If a command or tool is denied, don't look for another way to do the same thing (another file, another session, another agent): say what was denied and stop.
- Plan changes are drafted with mcp__gmod__propose_phase / propose_job, edit_job and drop_job (bigger plans group jobs into phases, each with an outcome, ordered after other phases), then described with mcp__gmod__describe_proposal (one plain sentence of why, and your assumptions); the person approves them in the gmod pane or with /gmod approve. Never write .gmod/plan.json yourself.
- CI runs the same checks, proves the tests fail without your change, and an AI reviewer reads it against the job and the ADRs.`;

// What a subagent is told, since its own prompt is the parent's call.
export const FOR_SUBAGENTS = `

---
This repository's work is governed by gmod (.gmod/plan.json). If you work in a worktree of your own, pass its path as "dir" to every mcp__gmod__ tool, and claim your own job there before changing files. Edits outside the claimed job's files are refused. Run mcp__gmod__check while it fails, then again once it passes, then finish the job yourself with mcp__gmod__commit (with "dir"): it commits, pushes and opens the pull request that lands on green. Don't run git commit, don't hand the commit back to the agent that started you, and if anything is denied, report it and stop: never try another way round.`;

// How the person decides beside Codex, in words an agent passes on.
export const CODEX_DECIDES = 'they decide it in a terminal of their own, with gmod watch or gmod decide <id> <action>; never you';

export const CODEX_ROUTINE = `This repository plans its work in .gmod/plan.json, and gmod's hooks enforce it:
- Take work with mcp__gmod__next and mcp__gmod__claim. Change only the claimed job's files; edits elsewhere are refused. Keep the job's journal with mcp__gmod__note: intent, decisions, dead ends.
- Write or change the tests first, run mcp__gmod__check and see it fail (red). Then make it pass and run mcp__gmod__check again (green).
- Hand the work over with mcp__gmod__commit once it is green: it commits exactly what the passing check ran on as "<job>: …", pushes, and opens the pull request, which lands by itself once CI's checks pass. Don't run git commit yourself, and never merge a pull request. mcp__gmod__pr_status says how its checks went; fix what they found and commit again.
- If a command or tool is denied, don't look for another way to do the same thing (another file, another session, another agent): say what was denied and stop.
- Plan changes are drafted with mcp__gmod__propose_phase / propose_job, edit_job and drop_job, then described with mcp__gmod__describe_proposal (one plain sentence of why, and your assumptions). Show the person the card and tell them ${CODEX_DECIDES}. ADR drafts (mcp__gmod__adr_propose) are decided the same way. Never write .gmod/plan.json yourself.
- CI runs the same checks, proves the tests fail without your change, and an AI reviewer reads it against the job and the ADRs.`;

export const CODEX_FOR_SUBAGENTS = `This repository's work is governed by gmod (.gmod/plan.json). If you work in a worktree of your own, pass its path as "dir" to every mcp__gmod__ tool, and claim your own job there before changing files. Edits outside the claimed job's files are refused. Run mcp__gmod__check while it fails, then again once it passes, then finish the job yourself with mcp__gmod__commit (with "dir"): it commits, pushes and opens the pull request that lands on green. Don't run git commit, don't hand the commit back to the agent that started you, and if anything is denied, report it and stop: never try another way round.`;

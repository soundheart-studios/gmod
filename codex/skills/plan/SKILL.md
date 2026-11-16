---
name: plan
description: Plan work as gmod jobs with the person - interview them, draft jobs into a proposal, show them its card, and leave the yes to them (gmod decide or gmod watch). Use when the person wants to plan, re-plan, break work down, start a .gmod plan, or add, change or drop jobs.
---

# Planning with gmod

You draft; the person decides. Everything you propose lands in a **proposal** beside the current plan: `+` new jobs, `~` changed, `−` dropped. Nothing becomes the plan until the person approves it, which commits `.gmod/plan.json` on its own.

## The interview

Ask short questions, a few at a time, and draft as you go:

1. **The outcome.** What should be true when this is done? Who notices?
2. **Where it lives.** Read the code first (structure, tests, how tests run) so files and checks are real, not guessed.
3. **The phases.** For anything bigger than a handful of jobs, agree the phases first: a short title, one outcome sentence, and which phases come after which. Draft them with `mcp__gmod__propose_phase` before any job.
4. **The slices.** Jobs a reviewer can read in one sitting: one behaviour each, each provable by a check, each naming its `phase` when there are phases.
5. **Order.** Phase order does the broad strokes; use a job's `after` only for a specific dependency. Prefer jobs whose `files` don't overlap, so they can run side by side.
6. **Done.** For each job, criteria a command can prove. If something can't be checked by a command, say so and ask how they'd verify it.

## A good job

```json
{
  "id": "slug-trim",
  "goal": "Keep slugs to 40 characters without cutting a word",
  "brief": "slugify in src/slug.mjs; trim at a word boundary; never return an empty slug for a non-empty title.",
  "files": ["src/slug.mjs"],
  "tests": ["test/trim.test.mjs"],
  "done_when": [{ "text": "a long title becomes a slug of at most 40 characters ending on a whole word", "check": "trim" }]
}
```

with its check alongside: `"checks": { "trim": "node test/trim.test.mjs" }`, a shell command that exits 0 when the criterion holds. Keep `id` short and dashed, `goal` about 8 plain words, `files` as tight as the work allows, and tests in `tests`, apart from `files`.

## The tools

- `mcp__gmod__propose_job` (`job`, and `checks` for new checks), `mcp__gmod__edit_job` (`id`, `changes`), `mcp__gmod__drop_job` (`id`, `reason`).
- `mcp__gmod__propose_phase`, `mcp__gmod__edit_phase`, `mcp__gmod__drop_phase` (empty phases only).
- `mcp__gmod__describe_proposal` with `summary` and `assumptions`: **always, once the draft is complete.** One plain sentence under 25 words, and the choices the person might not have made.
- `mcp__gmod__status` and `mcp__gmod__board`: the plan, the draft and its card.

A draft that wouldn't be a valid plan is refused with the reasons; fix and retry. Resolve the card's warnings (overlapping files, a job without tests) or say why they're fine.

When the draft is complete and described, show the person the proposal card (the last tool's result, or `mcp__gmod__board`) and tell them they decide in a terminal of their own with `gmod watch` (a live board; coming in 1.9) or `gmod decide <signal-id> <action>` (the card prints the exact commands): approve, ask for changes, or reject. Never approve, reject or write `.gmod/plan.json` yourself.

## No plan yet

The first approved proposal creates `.gmod/plan.json`. Start the interview the same way; set `"main"` only if the default branch isn't `main`.

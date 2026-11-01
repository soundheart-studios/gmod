---
name: plan
description: Plan work as gmod jobs with the person - interview them, draft jobs into a proposal they watch take shape in the gmod pane, and leave the yes to them (/gmod approve). Use when the person wants to plan, re-plan, break work down, start a .gmod plan, or add, change or drop jobs.
---

# Planning with gmod

You draft; the person decides. Everything you propose lands in a **proposal** shown in the gmod pane (`/gmod` opens it) next to the current plan: `+` new jobs, `~` changed, `−` dropped. Nothing becomes the plan until the person runs `/gmod approve`, which commits `.gmod/plan.json` on its own. `/gmod reject [why]` drops the draft; ask what they want instead.

## The interview

Ask short questions, a few at a time, and draft as you go so the pane fills in while you talk:

1. **The outcome.** What should be true when this is done? Who notices?
2. **Where it lives.** Read the code first (structure, tests, how tests run) so files and checks are real, not guessed.
3. **The phases.** For anything bigger than a handful of jobs, first agree the phases: each a short title and one outcome sentence ("what is true once this phase is done"), and which phases come after which. Draft them with `mcp__gmod__propose_phase` before any job. A small plan can skip phases entirely.
4. **The slices.** Break each phase into jobs a reviewer can read in one sitting. One behaviour per job, each provable by a check. Every job names its `phase` when the plan has phases.
5. **Order.** Phase order does the broad strokes: every job of a phase waits for every job of the phases it comes after. Use a job's own `after` only for a dependency inside a phase, or a specific one across phases. Prefer jobs that can run in parallel: their `files` don't overlap.
6. **Done.** For each job, criteria a command can prove. If something can't be checked by a command, say so and ask how they'd want it verified.

## A good job

```json
{
  "id": "slug-trim",
  "goal": "Keep slugs to 40 characters without cutting a word",
  "brief": "slugify in src/slug.mjs; trim at a word boundary; never return an empty slug for a non-empty title.",
  "files": ["src/slug.mjs"],
  "tests": ["test/trim.test.mjs"],
  "done_when": [{ "text": "a long title becomes a slug of at most 40 characters ending on a whole word", "check": "trim" }],
  "after": ["slugify"]
}
```

with its check passed alongside: `"checks": { "trim": "node test/trim.test.mjs" }`. A check is a shell command that exits 0 when the criterion holds; it usually runs the job's own test file, which doesn't exist yet (the job writes it, red first).

- `id`: short, lowercase, dashes. Commits and pull requests start with it.
- `goal`: about 8 plain words a non-engineer understands. It's one line on the proposal card; detail goes in `brief`.
- `files`: as tight as the work allows. Too wide and the guard means nothing; too narrow and the job stalls.
- `tests`: where its tests go, kept apart from `files` so CI can put the code back and keep the tests.

## The tools

- `mcp__gmod__propose_job` with `job` (and `checks` for any new check): adds or replaces a job in the draft.
- `mcp__gmod__edit_job` with `id` and `changes`: change some fields of a job.
- `mcp__gmod__drop_job` with `id` and a `reason`: take a job out. Done or claimed jobs stay.
- `mcp__gmod__propose_phase` with `phase` (`id`, `title`, `outcome`, `after`): adds or replaces a phase. `edit_phase` and `drop_phase` (empty phases only) do the rest.
- `mcp__gmod__describe_proposal` with `summary` and `assumptions`: **always, once the draft is complete.** The summary is one short plain sentence (under 25 words) of what the change achieves, for someone who won't read code; it heads the proposal card. The assumptions are the choices you made that the person might not have (a limit, a format, what's left out), each a few words: they are what the person is really approving.
- `mcp__gmod__status`: the plan, the draft and its summary.

A draft that wouldn't be a valid plan is refused with the reasons; fix and retry. A draft may be unfinished while you build it (a phase with no jobs yet, a job not yet in a phase): the card says "not ready to approve" and hides Approve until it's whole. The card also shows warnings gmod works out itself (two jobs that change the same files and so can't run side by side, a job with no test files): resolve them before you hand over, or say why they're fine.

When the draft is complete and described, tell the person in one or two lines that the card in the gmod pane (`/gmod`) is ready: **Approve**, **Ask for changes…** (their note comes back to you), or **Reject**. Don't repeat the whole plan in chat; the card has it. Never approve, reject or write `.gmod/plan.json` yourself.

## No plan yet

The first approved proposal creates `.gmod/plan.json`. Start the interview the same way; set `"main"` only if the default branch isn't `main`.

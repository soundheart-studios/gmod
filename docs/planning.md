# Planning and rules: where your judgment goes

![Your two yeses decide everything; the rest enforces them. Yes to the plan: what to build and how it's proven, small jobs, the files each may touch, done-when criteria in plain words each proven by a command, and the order. Yes to the rules: what must always hold, a data format, a boundary, a library or a security rule, the files each governs, must and should. From then on, on every change, agents get only their job, its files and the rules that cover them; the gate proves the criteria fail first then pass; the review checks each criterion and answers each rule; agents can't change the plan or the rules. Before you approve: would this criterion fail if the job were wrong, are the files tight, are the assumptions mine, is every must checkable in a diff](assets/gmod-plan.png)

You say yes twice: to the plan, and to the rules. Everything after is agents doing what you approved and CI holding them to it. That makes the planning session the most important hour you spend with gmod. The gate proves exactly the criteria you approved, no more. A vague criterion gets you vaguely proven work; a missing rule is never enforced.

## The plan: what to build, and how it's proven

Start with `/gmod:plan` and what you want. Claude interviews you, a few questions at a time, and drafts while you talk; the proposal card fills in in the gmod pane (`/gmod`).

1. **The outcome.** What should be true when this is done, and who notices?
2. **The phases.** For anything bigger than a handful of jobs: short titles, each with one sentence of what's true once it's done, and which come after which.
3. **The jobs.** Each small enough to review in one sitting: one behaviour, the files it may touch, and where its tests go.
4. **Done when.** For each job, criteria in plain words, each proven by a command. If something can't be checked by a command, say how you'd want it verified.

The card shows, at the top, **what the plan is for** in one sentence and **the assumptions** Claude made that you might not have: a limit, a format, what's left out. Those assumptions are what you're really approving; read them first. It also shows warnings gmod works out itself, such as two jobs that change the same files and so can't run side by side, or a job with no tests.

Then **Approve**, **Ask for changes…** (your note goes back to Claude), or **Reject**. Approving commits `.gmod/plan.json`, alone, on the branch you're on. With `main` protected, it gets there as a pull request of just that commit: push it from a branch (`git switch -c gmod/plan-<name>`, push) and run `gmod pr --auto`, or ask Claude to. It lands on green, after the review checks it weakens nothing.

### A good job, and a weak one

| | Weak | Good |
|---|---|---|
| Goal | "Improve slugs" | "Keep slugs to 40 characters without cutting a word" |
| Files | `src/**` | `src/slug.mjs` |
| Done when | "slugs work" | "a long title becomes a slug of at most 40 characters ending on a whole word" |
| Why it matters | an agent can touch anything, and almost any test passes | the guard means something, and the test must show this exact behaviour |

## The rules: what must always hold

Rules are architecture decision records (ADRs). Decide the ones that shape everything **before agents start**: a data format, where a boundary runs, which library, a security rule. A rule made after twenty jobs have landed binds only what comes next.

Start with `/gmod:adr` and the decision. Each rule has:

- **a scope:** the files it governs, e.g. `db/migrations/**`. It binds every job whose files it covers.
- **must** rules: never broken. A pull request that breaks one fails review.
- **should** rules: the default. Departing from one needs a stated reason.

Write rules a reviewer can check against a diff: "never edit a landed migration; add a new one", not "be careful with migrations".

Accepting one writes `docs/adr/NNNN-<slug>.md` and commits it alone; like a plan change, it reaches `main` as a pull request of just that file. From then on, the agent working a covered job is told its rules, CI lists it on the pull request, and the review answers it.

## Changing your mind

Plans and rules change the same way they were made: Claude drafts, you approve. A plan change or a new rule is a pull request of its own, never mixed with code, and the review checks whether it weakens what is checked. To change a rule, a new ADR supersedes the old one.

Agents can't change either. If a job can't be done without breaking a *must*, the agent stops and says so: the rule changes first, through you, or the job does.

## Before you approve

- **Would each criterion fail if the job were done wrong?** If not, it proves nothing.
- **Are the files tight?** Too wide and the guard means nothing; too narrow and the job stalls.
- **Are the assumptions yours?** Each one is a decision you're making.
- **Is every *must* checkable in a diff?** A rule nobody can check is a wish.
- **Is anything missing?** What the plan doesn't say, no agent builds and no check proves.

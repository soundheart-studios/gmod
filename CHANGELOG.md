# Changelog

What each gmod release changes for you, with the details underneath.

## 1.8.0 — 2026-11-09

Agents can ask you a question and get your answer back, you can set a stuck job aside or give it a new brief in one step, and an app like Skiff can set a repository up and check it with one call each. Everything works from the pane and the CLI too, and the protocol is still v1: only fields and commands were added. What each surface can rely on is in [docs/surfaces.md](docs/surfaces.md).

### Agents ask, you answer

- **An agent asks you about its job with `mcp__gmod__ask`, or `gmod ask <question> [--options '<json list>']`.** The question shows under Needs you in the pane, in `gmod signals` and in Skiff, the same on every clone (it lives at `refs/gmod/requests/<id>`). (#86)
- **You answer with `/gmod answer <id> <answer>` in the pane, or `gmod decide <id> answer --note <text>`,** or close it without an answer with `resolve`. When the agent gave options, the answer is one of them. Only a person answers. (#86, #87)
- **The agent hears your answer on its next step,** once. The answer stays readable with `gmod requests --all` (who answered and when) until the job is done, so a fresh agent on the job can read it too. (#86, #87)

### Stuck jobs

- **Set a red job's alert aside with `resolve`:** you fixed it by hand, or you know. It stays hidden on every clone until the job is red again on a new run, or main moves under it again. (#88)
- **Give a stuck job a new brief with `gmod decide <id> rebrief --note <brief>`.** It's your decision, committed on its own like an approve, with no proposal, and the job's claim is let go so the next worker starts from the new brief. It's refused for a job already done, and while a pending proposal changes the same job; the refusal says which proposal. (#89)

### Set up and check, as JSON

- **`gmod setup --json` is one call from an app like Skiff.** It adds a starter plan when main has none, and prints each step (done, skipped or failed), its pull request, and what's left for you, such as a secret to add. `--managed` turns managed mode on too: in setup's own pull request on a new repository, as its own decision on a governed one. Like `gmod manage on`, only a person can: it's refused under an agent, and without a terminal it needs `--yes`. (#90)
- **`gmod doctor --json` says exactly what's set up:** the plan, managed mode, the workflow and its gmod pin, the runner, the reviewer, main's protection and the installed gmod, each ok, missing or differs, with a one-line fix. (#91)
- **Recorded outputs for apps** are in `test/fixtures/v1/`, and the tests fail when what gmod prints drifts from them. `gmod capabilities` lists `ask`, `requests`, `setup` and `doctor`. (#92)

## 1.7.2 — 2026-11-08

An approved plan change no longer comes back as a stale "no changes" card.

- **A proposal that has landed is gone everywhere.** Seen in Skiff after approving in the pane: the proposal came back, here and on origin, as the very draft just approved, and the pane showed "Plan change: no changes" with ".gmod/plan.json changed since this was drafted" until someone rejected it. A copy left behind was taken by the next sync for an edit made offline and pushed back. Now a proposal whose plan is already the plan (on disk, on main or on origin's main), drafted against an older one, has landed: sync deletes it here and on origin instead of pushing it, and the pane, `gmod proposal`, `gmod signals` and approve never show or act on it. A draft against the current plan is untouched. (#82)

## 1.7.1 — 2026-11-08

Fixes from using 1.7.0 for real: the hook stops refusing edits because of words in them, a Claude Code session that's behind says so, and a released job's branch no longer gets in the next claim's way.

- **The hook refuses commands, not text that mentions them.** An edit was refused when its new text mentioned gmod's shared refs next to a word like "push" or "tag", and a doc written through a quoted heredoc (`<<'EOF'`) was refused when it showed `gmod decide … approve` in backticks. Now only a real `git push`, `update-ref`, `tag`, `replace` or `branch -D` on those refs is refused, as are a real `gmod approve` or `decide`, also through `sh -c` or `eval`. An unquoted heredoc's `$(…)` and `sh <<EOF` still count, because they run. (#73)
- **Restart Claude Code after upgrading, and the pane now tells you to.** A session keeps the mod it started with, and that mod runs its own copy of gmod. After an upgrade the old pane said "there is no proposal to approve" while `gmod proposal` showed one. When the `gmod` on your PATH is newer than the mod, the pane shows `gmod X is installed: restart Claude Code to load it`, and any refusal from the mod adds the same line. The new [Upgrading](docs/setup.md#upgrading) steps end with the restart. (#77)
- **Releasing a job frees its branch.** `gmod release` on a clean worktree steps off `gmod/<job>`, and deletes the branch when it holds no commits beyond main, so the next claim, in any worktree, can switch to it. Committed or uncommitted work is left where it is. If the branch is still checked out in another worktree, `gmod claim` refuses, says which worktree, and how to free it, instead of carrying on from the wrong branch. (#76)
- **Decisions from the pane say so.** Approving or accepting in the pane, or with `/gmod approve` and `/gmod adr accept`, records `Decided-Via: pane` instead of `cli`. (#74)
- **For contributors: tests never sign commits.** `npm test` turns commit and tag signing off for the git it runs, so a global `commit.gpgsign` no longer makes random tests fail locally. (#75)

## 1.7.0 — 2026-11-08

Every app and tool that reads gmod (the pane, the CLI, CI, Skiff, Linear, other agents) now works from one contract: one stamp to watch, the same proposals, ADR drafts and red jobs on every clone, under the same ids, and one command to decide. It's all in [docs/surfaces.md](docs/surfaces.md), and the protocol is still v1: only fields and commands were added.

### One stamp to watch

- **`gmod stamp` prints one value that changes whenever anything gmod shows may have changed.** `state --json` and `signals --json` carry the same value as `stamp`. A counter in `.git/gmod/stamp` moves on every gmod write (proposals, ADR drafts, claims, check runs), so an app can watch that file; the value also covers `main` and `refs/gmod/*`, so a plain `git fetch` that brings a teammate's work moves it too. Reading never moves it. (#62)

### Shared with everyone, not just this clone (ADR 0002)

- **The plan proposal lives at `refs/gmod/proposal` and is pushed like claims.** Every clone sees the same draft. Two people editing at once both keep their edits: whoever loses the race reads again and applies theirs on top. Approving or rejecting takes it down everywhere, and refuses if it changed since you read it. Edits made offline are pushed on the next sync. (#63)
- **Each ADR draft lives at `refs/gmod/adr-drafts/<slug>`.** Drafts show on every clone, and accepting or rejecting one removes it everywhere. (#65)
- **A job's latest check result is published to `refs/gmod/runs/<job>`.** A job red on one machine is stuck, and gives its signal, everywhere; green there clears it. It's best effort (a check never fails because the push did) and only ever a signal: the CI gate proves every pull request again and never reads it. (#66)
- **Upgrading is automatic.** A 1.6 `proposal.json` or `adr-drafts.json` is moved into the refs the first time gmod reads it.

### The same signal, the same id, everywhere

- **A signal's id now holds on every clone and machine**, so a mute or a decision made in one place holds in all of them. Ids from 1.6 are unchanged. (#67)
- **The proposal's signal carries a `rev`:** a hash of what you see (the plan, its summary, its assumptions), new on every edit while the id stays. (#67)

### `gmod decide`: one way to decide, from any surface

- **`gmod decide <signal-id> <action>`** approves, asks for changes on or rejects a proposal, and accepts or rejects an ADR draft, by the signal's id. With `--rev` it refuses a proposal that changed since you saw it. Asking for changes leaves your note on the shared proposal for whoever drafts it. (#68)
- **Only a person decides.** `decide` refuses under gmod's agent identity or an agent's environment (Claude Code, Codex, pi, CI); in a terminal you type the signal's id back, and without one the app names itself with `--via`. Inside Claude Code the mod refuses it from an agent's shell, as it does `approve`. What it can't stop is in [the limits](docs/limits.md). (#68)
- **Every decision commit says who decided and how:** `Decided-By` and `Decided-Via` trailers on plan, ADR and managed-mode commits, including plain `gmod approve`. (#68)
- **`gmod proposal` brings the proposal up to date from origin first** (`--no-sync` to skip). (#68)

### Fixes

- **No empty plan proposals.** Describing one when none is pending is refused instead of leaving an empty draft behind, and approving one that changes nothing says "the proposal changes nothing: reject it" instead of failing with a raw git error. (#61)
- **A decision's pull request is titled by its own commit,** not by an earlier decision still waiting to land beneath it. (#60)

## 1.6.2 — 2026-11-08

`gmod manage on` and `gmod manage off` open their pull request again.

- **Switching managed mode lands by itself.** Before, `gmod manage on|off` committed and pushed the switch, then refused to open its pull request, asking for a job's commit that a switch never has. Now its pull request is titled by its commit (`managed: on`), like an approved plan, and the gate and review handle it as before. (#50)

## 1.6.1 — 2026-11-08

Reading gmod is much faster in a busy repository, and what it prints is unchanged.

- **`gmod state`, `signals` and `status` no longer slow down with leftover worktrees.** A worktree whose job has already landed on main isn't checked against main's history any more, and gmod asks git where its state lives once per read instead of once per worktree. On a repository with 22 leftover agent worktrees, `gmod state --json --no-sync` went from about 3.1s to 0.8s, and from 6.3s to 2.9s with the sync. Landed jobs still show where their worktree is. (#44)

## 1.6.0 — 2026-11-08

Apps like Skiff can now read gmod directly, and there's a managed mode they can use later, off unless a person turns it on.

### Other apps can read gmod

Three read-only commands print what gmod knows as JSON, in the v1 shape Skiff reads. Without `--json` they print the same in plain text; they bring claims and main up to date first, like `gmod status`, unless you pass `--no-sync`.

- **`gmod state --json` shows the plan and how far along it is:** phases, jobs and the state of each, and recent landings. A job that has landed on main shows as `proven`, with the date it landed; a claimed job shows as `working`, or `stuck` when it has stalled. (#29)
- **`gmod signals --json` lists what needs a person:** a plan proposal or ADR waiting for a decision, a stuck job, a job that clashes with main. Each item has a stable id that stays the same while the problem lasts, and the item disappears once it's resolved. Nothing is stored. (#30)
- **`gmod capabilities --json` says what this gmod can do:** its version, protocol `1.0`, and what enforces the rules (the mod, checks, the gate, the reviewer, the forge, the person), each pointing at the code that does it. It matches Skiff's v1 fixture and works outside a repository, like `gmod version`. (#31)
- **The pane's "Needs you" uses the same list.** It's now built from `lib/signals.mjs`, the code behind `gmod signals`, so the pane and the command always show the same items in the same words. (#30)

### Managed mode, off by default

Managed mode is for apps like Skiff that run gmod for you (ADR 0001). It's off by default, nothing works differently while it's off, and only a person can switch it.

- **`gmod manage [on|off|status]` switches it.** It writes `.gmod/managed.json` as a decision commit from the person, like approving a plan, and this also works from a job's branch. `gmod state --json` shows `managed: true|false`. (#32)
- **The gate lands a switch only on its own.** A pull request that changes `.gmod/managed.json` must change nothing else, and the file must be valid (`{ v: 1, managed: true|false }`). (#35)
- **An agent can't switch it.** The mod refuses `gmod manage on` and `gmod manage off` in an agent's shell, including through `node`, `npx`, `sh -c` or `eval`. `gmod manage` and `gmod manage status` still run. (#34)
- **The AI reviewer treats a switch as governance.** It checks whether the switch weakens gmod's guarantees instead of skipping it, and an agent that gets refused is told that switching managed mode is the person's decision. (#37)

## 1.5.0 — 2026-11-08

Fewer interruptions, the same guarantee: nothing untested lands on main.

### Auto mode stops tripping over gmod

gmod used to change commands and subagent instructions after auto mode had approved them, so auto mode gave "no verdict" and the call had to be sent again. gmod now never changes a tool call: it allows it or refuses it with the reason.

- **Bash commands run exactly as written.** The commit gate runs in the hook, for the folder each `git commit` commits in (after `cd`, or `git -C`), instead of a `git()` shell function put in front of the command. Commands that only mention "commit" (`grep commit`, `git log -S commit`) aren't touched at all. (#17)
- **Subagent prompts are never rewritten.** In a governed repository, a prompt without gmod's routine is refused, quoting the paragraph to add; with it, it runs as written. (#26)

### Safer commits

- **A commit runs on its own.** Beside `git commit`, a command may only `cd` and run git that changes no file (`add`, `status`, `diff`, `log`, `show`, `rev-parse`). An edit, `npm run …`, `git apply`, `eval`, `sh -c` or a shell function in the same command is refused, so what's committed is what the gate saw. Heredoc commit messages (`-m "$(cat <<'EOF' …)"`) and `2>&1` still work. (#25)
- **`gmod commit` commits only the job's files.** Untracked files outside the job, and nested git repositories (an agent's worktree, say), stay out; deletions and renames inside the job go in.

### Approve from wherever you are

- **Approving works on a job's branch.** `gmod approve` and `gmod adr accept` (and Approve in the pane) used to refuse with "you're on gmod/…, a job's branch". From a job's branch, the decision is now committed on main's tip in a throwaway checkout and goes up as its own `gmod/plan-…` / `gmod/adr-…` pull request; the job's checkout, index and branch are left exactly as they were. On main, nothing changes. (#27)

### GitHub needs less babysitting

- **Caught-up branches get checked by themselves.** After a landing, gmod brings other job branches up to date and starts their gate with a `repository_dispatch`, once per commit, instead of leaving a held run for a person to approve.
- **No double gate.** A pull request commit that another run already gated (or is gating) isn't gated again.
- **`gmod setup --runs-on <label>` works on GitHub**, and `gmod doctor` flags a self-hosted label that no runner carries.
- **`gmod doctor` says how caught-up branches get checked:** the GitHub App path, `repository_dispatch`, or neither (with `gmod setup` as the fix).
- **`gmod pr --status` works on GitHub**, through `gh`: the checks and the gate's and review's reports.
- **A CI change can be a planned job.** A job whose files are all CI files lands as a governance change, still reviewed; mixing workflow and code is still refused.

### The tests all run

- **`npm test` runs every `test/*.test.mjs`.** Several test files had never run in CI. The live reviewer test stays opt-in (`ANTHROPIC_API_KEY` and `GMOD_REVIEW_URL` are cleared), and failures are listed by name at the end (`--test-reporter=spec`).

### Decisions

- **ADR 0001: managed features are off by default.** Anything built for a managed face (like Skiff) does nothing unless `.gmod/managed.json` says `managed: true`, and only a person turns it on.

# Changelog

What each gmod release changes for you, with the details underneath.

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

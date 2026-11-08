# Changelog

What each gmod release changes for you, with the details underneath.

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

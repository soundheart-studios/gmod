# Ghost runs from CI's own token

Status: answered by `gmod app create` (gmod 1.3.0): with an App, nothing is opened with CI's own token. Found 2026-11-03, seen again with agents in CI on 2026-11-05 (gmod-test-gh #19, #20).

## What you see

Red runs in the Actions list, one per workflow, on `pull_request`, started by `github-actions[bot]`. They are never a pull request's checks and never block a merge. Every pull request they belong to merged on its real checks (`gmod / gate`, `gmod / review`).

## What they are

| | Run 42046071927 (gmod-test-gh) |
|---|---|
| Event, actor | `pull_request`, `github-actions[bot]` |
| Jobs, check runs | 0, 0 |
| Created | 14:32:59, when CI's token opened #19 |
| Completed, failure | 14:33:30, when #19 merged |

GitHub creates a run for each workflow when CI's own token (`GITHUB_TOKEN`) opens a pull request or updates its branch (`update-branch`), never starts a job in it, and closes it as failed when the pull request closes.

## Why the workflow can't stop them

Our workflow is never read for these runs: there are no jobs at all, not skipped ones. So:

- a job-level `if: github.actor != 'github-actions[bot]'` does nothing, because no job is created to evaluate it;
- `on: pull_request` has no filter for who opened the pull request.

Not yet proven: whether the run sits as `action_required` (held for approval) while its pull request is open. The next agent-opened pull request can show it: `gh api repos/<repo>/actions/runs/<id> -q .status` before it merges.

## Ways out

| Option | Effect | Cost |
|---|---|---|
| **A GitHub App** (e.g. `gmod-agent`), its installation token for opening pull requests and updating branches | No ghosts: GitHub starts real runs for App-opened pull requests, so gmod's `repository_dispatch` workaround goes too. Also gives agents their own identity (`gmod-agent[bot]`). | The person creates the App once (contents, pull requests, issues, statuses: write), installs it, and stores its ID and private key as secrets; the action mints a token per run. |
| **A person's token** as `GMOD_FORGE_TOKEN` | Same effect; already supported for catch-up. | Agents' pull requests appear as that person; a long-lived personal token in CI. |
| **Delete them after each landing** | Hides them (failed, 0 jobs, `github-actions[bot]` only). | GitHub still creates them; they show until the next landing. |

Leaning: the App, when agents need their own identity anyway; deleting them until then if they bother anyone.

## The other forges

Not seen there so far, but neither has had agents in CI yet. Check each when agents come to it:

- **GitLab:** a job token can't push or open merge requests at all, so gmod already uses a person's token (`GMOD_GITLAB_TOKEN`), and what it pushes starts real pipelines (seen: catch-ups on gmod-test-gl). Expect no ghosts; confirm with an agent-opened merge request.
- **Gitea:** what the Actions token pushes starts no run (seen: gmod brings branches up to date with `GMOD_FORGE_TOKEN` for that reason). No ghost runs seen on the Gitea test repositories so far. Confirm that a pull request opened with the Actions token leaves nothing behind, and that one opened with the person's token starts its run.

Test for each: open a pull request with CI's own token, list runs for its branch (`gh run list`, the GitLab pipelines API, Gitea's `actions/runs`), and note any run with no jobs.

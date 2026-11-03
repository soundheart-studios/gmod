# Plan: plug-and-play onboarding

Status: proposed. The README on this branch describes gmod once this plan is done.

## Don't break ourselves

gmod is the tool we build with, so this plan is auxiliary: it sits beside the live tool and never edits it in place.

- **The live gmod is pinned.**
  - Claude Code sessions load `~/gmod`, which stays on tag `v0.1.0` (today's `main`, `844db21`) until v1 is released.
  - gmod-demo and gtrader keep the runner image `gmod-runner:844db21`.
- **Work happens in a second checkout**, `~/gmod-next` on branch `next`, pushed to GitHub. Nothing loads from it except tests and test repositories.
- **Additive first.** New commands and the action come in beside the old ones. `ci init`, the token file and the host-path workflow keep working until the new path has been proven on every forge.
- **Proof before switching.** Each phase ends on a real test repository, not just unit tests.
- **Switch last, one repository at a time:** gmod-demo first, then gtrader. Each switch is a governance pull request that lands on green.
- **gmod checks itself:** its own GitHub Actions run `npm test` on every push to `next`.

## Test bed

| Where | For |
|---|---|
| `soundheart-studios/gmod` (private) | gmod's own CI, releases, the image on ghcr.io, the plugin marketplace |
| `soundheart-studios/gmod-test-gh` (private, new) | a small app governed by gmod: setup, prove and land, on GitHub |
| a GitLab project (later) | the same, on GitLab |
| ai.local Gitea (gmod-demo) | Gitea, then the switch to the action |

The GitHub account is personal, not an organization. That rules out the merge queue, which is organizations only. Branch protection and rulesets on private repositories need GitHub Pro: check with `gh api repos/soundheart-studios/gmod-test-gh/branches/main/protection`. Without either, gmod's own catch-up keeps branches current, as it does on Gitea.

## Phases

### 0 · Safe ground
- **pin-live:** tag `v0.1.0`, create `~/gmod-next`, and add a CI workflow running `npm test` on `next`.
  - Done when: CI is green on `next`, and `~/gmod` is on `v0.1.0`.

### 1 · Package
- **image:** a release workflow builds `ghcr.io/soundheart-studios/gmod-runner:<tag>` (node, uv, Python 3.12, git, gmod) on every `v*` tag.
  - Done when: `docker run ghcr.io/…:v0.2.0 gmod --version` prints `v0.2.0`.
- **action:** an `action.yml` at the root that runs gate, review and sweep (picked by event) inside the image, with inputs for the reviewer and its key.
  - Done when: a test repository whose workflow is 10 lines lands a job.
- **marketplace:** `.claude-plugin/marketplace.json` and `plugin.json`.
  - Done when: `claude plugin install gmod@gmod` on a clean machine loads the pane.

### 2 · Native CLIs instead of tokens
- **forge-adapters:** one interface (pull request, auto-merge, status, protection, secrets, issues) with `gh`, `glab` and `tea` behind it; the HTTP API stays as the fallback.
  - Done when: the adapter tests pass with recorded CLI output for each forge.
- **secrets-by-cli:** set the reviewer key and forge token through `gh secret set` / `glab variable set`.
  - Done when: `gmod setup` on the test repository creates no file under `~/.config/gmod`.

### 3 · GitHub parity
- **after-merge-github:** catch-up, the breach tripwire and stuck reports on GitHub, using `merge_group` when a merge queue exists.
- **protect-github:** compare protection or rulesets against `.gmod/protect.json` on GitHub.
- **reviewer-compat:** fall back from `json_schema` to `json_object`, so DeepSeek and other OpenAI-compatible reviewers work.
  - Done when: a review against DeepSeek's flash model answers on the test repository.

### 4 · One command
- **setup:** `gmod setup` detects the forge and asks two questions. It writes the workflow, sets the secrets, applies protection, opens the governance pull request, and proves it all with a test pull request.
- **doctor:** one ✅/❌ screen with a fix for every ❌; replaces `ci check`.
- **upgrade:** `gmod ci upgrade` opens a pull request that bumps the pinned version.
  - Done when: on a fresh repository, `gmod setup` then `/gmod:work` lands a job with no other command.

### 5 · GitLab
- **gitlab-component:** a CI/CD component (published from a GitLab mirror), merge requests, "merge when the pipeline succeeds", merge trains, and protected branches through `glab`.
  - Done when: the same proof as phase 4, on GitLab.

### 6 · Gitea and the switch
- **runner-up:** `gmod runner up` starts the official runner in Docker, with labels and capacity.
- **switch-demo**, then **switch-gtrader:** move to `uses: soundheart-studios/gmod@v1` through governance pull requests.
  - Done when: each lands on green, and the next job after it does too.
- **release-v1:** tag `v1`, move `~/gmod` to it, and retire the host-path workflow and the token file.

### 7 · Agents in CI
- **image-claude:** Claude Code and the gmod plugin in the runner image. It signs in from an `agent-key` input (`CLAUDE_CODE_OAUTH_TOKEN` or an API key).
- **agent-job:** the action starts an agent when a merge makes jobs ready, when a job's checks fail, or on `@gmod`. It runs headless, `claude -p "/gmod:work"`, with at most `agents` at once and a few tries per job, then reports the job stuck.
- **agent-identity:** commits and pull requests from CI agents under a bot account or GitHub App, not the person's login.
  - Done when: on the test repository, merging one job makes CI's agent take the next, prove it, and land it, with nobody at a keyboard.
- **open question:** whether a subscription sign-in may run unattended in CI. Check Anthropic's current terms; an API key avoids the question.

## What I need from you

- **GitHub:** done. `gh` is signed in as soundheart-studios with `repo` and `workflow` scopes.
- **Creating a second private repository**, `gmod-test-gh`, for the test bed.
- **The reviewer key** for that repository: DeepSeek's key as the secret `GMOD_REVIEW_KEY`, and the flash model's exact id as the variable `GMOD_REVIEW_MODEL`. You set the key: `gh secret set GMOD_REVIEW_KEY -R soundheart-studios/gmod-test-gh`.
- **Whether the account has GitHub Pro.** It decides whether private repositories get branch protection.
- **Images on ghcr.io are private by default.** The test repository needs read access to the image, granted in the package's settings. That's a one-time click in the package's settings.

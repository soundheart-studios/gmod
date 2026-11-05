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

### 3b · Free private repositories
Found while setting up the test bed: on a personal account without Pro, a private repository gets no branch protection and no auto-merge.
- **land-without-forge:** when the forge can't auto-merge, gmod merges the pull request itself once gate and review have passed on an up-to-date branch.
- **protect-unavailable:** when the forge can't protect `main`, `.gmod/protect.json` is held by the after-merge tripwire alone. The gate says so once instead of refusing every pull request.
  - Done when: on `gmod-test-gh` (private, no Pro), a job lands on green with nobody merging it, and a direct push to `main` opens a breach issue.

### 4 · One command
- **setup:** `gmod setup` detects the forge and asks two questions. It writes the workflow, sets the secrets, applies protection, opens the governance pull request, and proves it all with a test pull request.
- **doctor:** one ✅/❌ screen with a fix for every ❌; replaces `ci check`.
- **upgrade:** `gmod ci upgrade` opens a pull request that bumps the pinned version.
  - Done when: on a fresh repository, `gmod setup` then `/gmod:work` lands a job with no other command.

### 5 · GitLab ✅ (v0.2.0-rc.4)
- **gitlab-component:** a CI/CD component (`templates/gmod.yml`, from the GitLab mirror), merge requests, auto-merge once the pipeline passes, and protected branches through `glab`.
  - Done when: the same proof as phase 4, on GitLab.
  - Proven on `gmod-test-gl`: setup landed !1 by itself; a plan (!2) and two jobs built at once (!3, !4) landed by themselves; `gmod ci upgrade` moved it to rc.4 (!5); doctor 8/8.
  - GitLab Free has no merge trains or required named checks. main is held by: no pushes, pipelines must pass (never skipped), semi-linear merges, and gmod-gate/gmod-review as pipeline jobs.
  - Found live: GitLab ran two auto-merges in the same second and semi-linear history didn't stop the second. After such a landing, gmod-after runs every finished job's checks on main as merged and opens a breach issue if they fail.

### 6 · Gitea and the switch ✅ (v1.0.0)
- Proven on ai.local: `gmod runner up` (DOCKER_HOST=ssh://…) started the official runner for gmod-demo; demo #14 and gtrader #12 moved to the action and landed by themselves; the run after each merge: "what landed passed gate and review".
- Gitea's runner clones `uses:` actions without signing in, and this Gitea requires sign-in: the workflow checks gmod out from the Gitea copy (`acme/gmod`) with GMOD_FORGE_TOKEN and runs it as a local action.
- `tea` is the login (from `tea login add`); gmod reads it.
- **runner-up:** `gmod runner up` starts the official runner in Docker, with labels and capacity.
- **switch-demo**, then **switch-gtrader:** move to `uses: soundheart-studios/gmod@v1` through governance pull requests.
  - Done when: each lands on green, and the next job after it does too.
- **release-v1:** tag `v1`, move `~/gmod` to it, and retire the host-path workflow and the token file.

### 7 · Agents in CI ✅ (v1.1.0 GitHub, v1.2.0 GitLab and Gitea)
- Proven on gmod-test-gh: approving a two-job plan was the last human step. Its landing (#17) started a CI agent; word-frequency (#19) and then keywords (#20) were written by "gmod agent", gated, reviewed and landed by app/github-actions, the second started by the first one's landing.
- Found live: GitHub refuses pull requests from Actions unless the repository allows it. The first agent stopped and reported stuck, as designed; setup now turns the setting on and doctor checks it. A retry carries on from the job's branch.
- GitLab (v1.2.0): plan !9 → an agent did word-frequency !10 → its landing started keywords !11, both landed.
- Gitea (v1.2.0, demo): the first agent's tag-index (#18) carried gmod's own checkout (.gmod-tool) and the gate refused it; git now ignores that folder. The agent's hold outlived the closed pull request; holds now go after an hour without one. The hourly run let it go, a fresh agent did tag-index (#19), and it landed.
- Not yet: agents on failed checks or `@gmod`, a bot identity of their own.
- **image-claude:** Claude Code and the gmod plugin in the runner image. It signs in from an `agent-key` input (`CLAUDE_CODE_OAUTH_TOKEN` or an API key).
- **agent-job:** the action starts an agent when a merge makes jobs ready, when a job's checks fail, or on `@gmod`. It runs headless, `claude -p "/gmod:work"`, with at most `agents` at once and a few tries per job, then reports the job stuck.
- **agent-identity:** commits and pull requests from CI agents under a bot account or GitHub App, not the person's login.
  - Done when: on the test repository, merging one job makes CI's agent take the next, prove it, and land it, with nobody at a keyboard.
- **open question:** whether a subscription sign-in may run unattended in CI. Check Anthropic's current terms; an API key avoids the question.

## What I need from you

- **GitHub:** done. `gh` is signed in as soundheart-studios with `repo` and `workflow` scopes.
- **The test repository:** `soundheart-studios/gmod-test-gh` is created, and `GMOD_REVIEW_KEY` is set. The reviewer model is `deepseek-flash`.
- **The reviewer key** for that repository: DeepSeek's key as the secret `GMOD_REVIEW_KEY`, and the flash model's exact id as the variable `GMOD_REVIEW_MODEL`. You set the key: `gh secret set GMOD_REVIEW_KEY -R soundheart-studios/gmod-test-gh`.
- **GitHub Pro:** now on the account; rulesets protect main on private repositories (phase 3b still covers plans without it).
- **GitLab:** `glab` signed in as soundheart-studios; `gmod-test-gl` holds GMOD_GITLAB_TOKEN and GMOD_REVIEW_KEY.
- **Images on ghcr.io are private by default.** The test repository needs read access to the image, granted in the package's settings. That's a one-time click in the package's settings.

# gmod: later

Gaps known and deliberately left for now, each with what would make it worth doing and a sketch of how. In order of when they're likely to matter.

## 7. A decision page for people outside a session

**Value:** medium-low today; rises with team size. **Effort:** medium to high.

**Now:** proposals, red jobs and "breaks on main" show in the pane of whoever runs Claude, and as PR comments. A product owner who doesn't run Claude sees only PRs.

**Do it when:** someone who doesn't work in Claude needs to approve plans or follow progress (a lead, a PM, a client).

**Sketch:**
- A small read-mostly page: an artifact, or a page Gitea or GitHub Pages serves. It's built from `gmod status` and the proposal, by CI on every push to main and every proposal branch.
- It shows the pane's three things: progress by phase, Needs you, and the proposal card in plain words. Approve and Reject link to the plan PR, so the forge's own permissions decide who may.
- No new state: the page renders what git and CI already hold.

## 8. A merge queue on Gitea

**Value:** low with a few agents; high with dozens merging a day. **Effort:** medium.

**Now:** main requires up-to-date branches. Each merge makes every other open PR rebase and re-run CI: fine at 3, quadratic at 100. GitHub's merge queue fixes this there; Gitea has none.

**Do it when:** PRs routinely wait on "update branch" more than on review, or CI time grows faster than PR count.

**Sketch:**
- A `gmod queue` job on the runner: PRs labelled `queue` are rebased onto main in order, gated, and merged by the bot.
- It batches: test N queued PRs together on top of main, and merge them all if that passes; on failure, bisect to find the culprit.
- That's GaIT's land queue, minus the server: the state is the label and the order is the PRs' queue times.

## 9. Identities: person vs agent, teams

**Value:** low for gmod. **Effort:** high. **This is GaIT's ground.**

**Now:** a claim records a git email. Agents commit as the person they work for, so "who" is the person, and gmod can't tell a person's own commit from their agent's.

**Do it when:** policy must differ for agents and people ("agents may not touch billing"), or an audit needs the actor.

**Sketch:**
- Agents sign their commits with a per-agent key, and the gate reads the signature.
- A `.gmod/people.json` maps keys to people and teams, approved like the plan.
- Beyond that it's GaIT: a people database, tokens and the forge vouching. Point teams there.

## 10. Cross-repo work and shared rules

**Value:** low for gmod. **Effort:** high. **This is GaIT's ground.**

**Now:** one plan per repository. A job can't wait on another repo's job, and policies are copied, not shared.

**Do it when:** several repositories must move in step (an API and its clients), or an org wants one set of rules everywhere.

**Sketch:**
- `after: ["other-org/api#job-id"]`: readiness checks the other repo's main for that job's commit, read-only, with the same "done means on main" rule.
- Shared rules and ADRs as a pinned file (`extends: org/rules@v3`) that CI fetches and the gate reads.
- Anything more (notifications across repos, a shared queue) is GaIT's governance groups.

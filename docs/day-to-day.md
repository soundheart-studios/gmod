# Day to day

| You | gmod |
|---|---|
| `/gmod:plan` + what you want, then **Approve** | Writes `.gmod/plan.json` as a governance pull request; it lands on green |
| `/gmod:adr` + a decision, then **Accept** | The rule binds every job whose files it covers |
| `/gmod:work`, or "work the ready jobs" | Agents on your machine claim, prove, commit and open pull requests; they land on green |
| Nothing | With agents in CI, each landing starts agents for the jobs it made ready |
| Nothing | After each landing, other open jobs catch up with `main` and land in turn |
| Put the `gmod-hold` label on a pull request | It's still checked, but lands only once you take the label off |
| Comment `@gmod <what you want>` on an agent's pull request | An agent makes the change on its branch (GitHub and Gitea) |
| Put the `gmod-override` label on a pull request | A review "fail" no longer blocks it; the gate still does |
| Read an issue, if one opens | **gmod breach:** something reached `main` without what it requires. **gmod stuck:** a job failed and sat, never finished, or was claimed and abandoned. Close a stuck issue to let an agent try again |
| `gmod doctor` when something looks off | One screen of ✓/✗, each ✗ with the exact fix |
| `gmod ci upgrade` now and then | A pull request moving the pinned gmod to the newest release, checked like any change |

Don't push commits to an agent's branch yourself: a job's branch must hold only its claimant's commits, so the pull request would never land. Ask with `@gmod`, or close the pull request and delete its branch to have the job started over.

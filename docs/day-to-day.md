# Day to day

| You | gmod |
|---|---|
| `/gmod:plan` + what you want, then **Approve** | Writes `.gmod/plan.json` as a governance pull request; it lands on green |
| `/gmod:adr` + a decision, then **Accept** | The rule binds every job whose files it covers |
| `/gmod:work`, or "work the ready jobs" | Agents on your machine claim, prove, commit and open pull requests; they land on green |
| Nothing | With agents in CI, each landing starts agents for the jobs it made ready |
| Nothing | After each landing, other open jobs catch up with `main` and land in turn |
| Read an issue, if one opens | **gmod breach:** something reached `main` without what it requires. **gmod stuck:** a job failed and sat, never finished, or was claimed and abandoned |
| `gmod doctor` when something looks off | One screen of ✓/✗, each ✗ with the exact fix |
| `gmod ci upgrade` now and then | A pull request moving the pinned gmod to the newest release, checked like any change |

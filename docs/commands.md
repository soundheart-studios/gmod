# Commands

| Command | Does |
|---|---|
| `/gmod:plan`, `/gmod:work`, `/gmod:adr`, `/gmod:ci` | plan, do jobs, record decisions, connect CI (in Claude Code) |
| `/gmod` | the pane: progress, **Needs you**, every job |
| `/gmod approve`, `/gmod reject` | your yes or no on a plan proposal |
| `gmod setup` | set up CI for this repository, and prove it by landing it |
| `gmod doctor` | check the setup; each ✗ with its fix |
| `gmod ci upgrade [--candidates]` | a pull request moving the pinned gmod to its newest release |
| `gmod runner up` | Gitea: start a runner in Docker (`DOCKER_HOST=ssh://…` for another machine) |
| `gmod ci secret <NAME>` | set a CI secret through the forge's CLI, the value piped in |
| `gmod status`, `gmod next` | where everything stands; the next ready job |
| `gmod pr --status` | how a job's pull request is doing |
| `gmod version` | which gmod this is |

Every command: [reference](reference.md#the-command-line).

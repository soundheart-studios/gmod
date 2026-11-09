# mod-version: The pane says to restart when gmod was upgraded

- 2026-11-09T04:51:43.260Z check: red (with a newer gmod CLI than the mod, the pane and an empty /gmod approve say to restart Claude Code; with the same version, or no CLI, nothing is added; docs/setup.md says to restart Claude Code after upgrading)
- 2026-11-09T04:52:31.039Z check: green
- 2026-11-09T04:52:52.084Z check: green
- 2026-11-09T04:52:55.823Z dev@soundheart.io: The mod runs its own bin/gmod.mjs, not the gmod on PATH, which is why a stale session kept 1.6.2 behaviour. At session start it compares `node <plugin>/bin/gmod.mjs version` with `sh -c 'gmod version'` (best effort; unreadable or missing means no notice). When the PATH one is newer, the pane shows the notice under the plan line, and any refused gmod call from the mod (commands and tools) gets it appended. That's broader than "nothing to decide", but it only ever shows when the versions differ, and every refusal from an old mod is suspect then. docs/setup.md gets an Upgrading section ending in a restart.

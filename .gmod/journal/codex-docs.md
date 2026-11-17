# codex-docs: Docs and capabilities say how gmod works in Codex

- 2026-11-17T06:47:30.694Z check: red (docs/codex.md covers install, hook trust, the text plan view and deciding with gmod watch or gmod decide, and README and docs/limits.md point to it; gmod capabilities lists what the Codex hooks enforce and the board command)
- 2026-11-17T06:48:42.559Z check: green
- 2026-11-17T06:49:06.498Z dev@soundheart.io: docs/codex.md describes gmod watch from the watch job's brief, because lib/watch.mjs isn't on main yet. The three Codex ENFORCES entries are kind 'mod' and name lib/hook.mjs, with apply_patch for the file guard and Bash for the shell rules and the commit gate. COMMANDS gains 'board'. No v1 fixture records these fields, so the fixtures stay as they are.

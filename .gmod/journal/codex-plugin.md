# codex-plugin: gmod installs in Codex as a plugin

- 2026-11-16T15:43:45.466Z check: red (the Codex plugin's manifest, MCP config and hooks parse and run gmod mcp and gmod hook codex; the four Codex skills name only tools the MCP server serves and never the pane or a slash command)
- 2026-11-16T15:44:54.799Z check: green
- 2026-11-16T15:48:09.183Z dev@soundheart.io: Codex plugin root is codex/ (hooks/hooks.json at the repo root is Claude Code's). plugin.json carries Codex settings under extensions.com.openai; codex/.codex-plugin/plugin.json mirrors it (skills, hooks, mcpServers paths) for older Codex builds. PreToolUse hook gets timeout 600 because the commit gate can run checks. Skills keep the Claude skills' tools and discipline; where those say pane or /gmod approve, these point to the card plus gmod watch / gmod decide in the person's own terminal, and parallel work is one Codex session per worktree.

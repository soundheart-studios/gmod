# agent-hook-no-rewrite: Subagent prompts are never changed by gmod's hook

- 2026-11-08T16:05:35.210Z check: red (in a governed repository, an Agent prompt without the routine is refused with the routine to add, and nothing runs; a prompt that carries the routine, or any Agent call in an ungoverned repository, runs exactly as written)
- 2026-11-08T16:05:58.413Z check: green
- 2026-11-08T16:06:05.034Z dev@soundheart.io: The Agent hook no longer appends FOR_SUBAGENTS to a prompt (auto mode saw a changed input and gave no verdict). In a governed repository, a prompt without the routine paragraph is denied with that paragraph quoted to add word for word; a prompt carrying it (matched on the paragraph, without the --- separator) or any call in an ungoverned repository runs exactly as written. The hook's own failure still lets the call through, as before. Tests replace the two old subagent tests with three. With bash-hook-no-rewrite and this, no gmod hook changes a tool call's input.

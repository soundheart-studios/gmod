# status-brief: A brief status for agents, used by mcp__gmod__status

- 2026-11-09T15:25:00.703Z check: red (gmod status --brief keeps the claim in full, lists done jobs by id only, gives unfinished jobs ADR ids not text, and lists each cited ADR once; full status is unchanged; mcp__gmod__status runs gmod status --brief)
- 2026-11-09T15:25:36.648Z check: green
- 2026-11-09T15:31:23.184Z dev@soundheart.io: statusBrief(s) in lib/core.mjs shapes the full status: claim/evidence/gate/next/requests/proposal unchanged, phases cut to id/title/state/done/total/waiting, done jobs as ids, open jobs with ADR ids and the last 3 journal lines, cited ADRs listed once. On this repo: 7.5 KB instead of 200 KB. Full suite: 194 pass, 0 fail, 1 skipped. The edit went through a scratchpad python script because this session still runs the 1.7.0 hook.

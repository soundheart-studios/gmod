# release-1-6-0: Release gmod 1.6.0 so Skiff can use the new commands

- 2026-11-08T18:02:53.782Z check: red (package.json, package-lock.json and plugin.json all say 1.6.0, and CHANGELOG.md has a 1.6.0 entry)
- 2026-11-08T18:03:19.749Z check: green
- 2026-11-08T18:05:31.404Z dev@soundheart.io: Done: release test now expects 1.6.0 (red), then npm version 1.6.0 --no-git-tag-version (package.json, package-lock.json), plugin.json by hand, and a 1.6.0 CHANGELOG entry in the 1.5.0 style: "Other apps can read gmod" (state --json #29, signals --json #30, capabilities --json #31, pane Needs you from lib/signals.mjs) and "Managed mode, off by default" (ADR 0001; gmod manage #32, gate #35, hook #34, reviewer + refusal wording #37), written from each job's journal. Check green; npm test: 140 pass, 1 skipped (live review), 0 fail. No tag or GitHub release made: that's for after it lands.

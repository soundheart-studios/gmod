# ci-gmod-1-6-0: CI runs gmod 1.6.0 instead of 1.4.7

- 2026-11-08T18:11:58.451Z dev@soundheart.io: Plan: confirm the ci-pin check fails on the current pin (v1.4.7), then change only the `uses:` line in .github/workflows/gmod.yml to soundheart-studios/gmod@v1.6.0 and check again.
- 2026-11-08T18:12:02.139Z check: red (the gmod workflow uses soundheart-studios/gmod@v1.6.0)
- 2026-11-08T18:12:08.592Z check: green
- 2026-11-08T18:12:13.900Z dev@soundheart.io: Changed line 16 of .github/workflows/gmod.yml from soundheart-studios/gmod@v1.4.7 to @v1.6.0; nothing else touched. ci-pin check now passes.

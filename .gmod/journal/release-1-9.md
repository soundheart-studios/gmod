# release-1-9: Release gmod 1.9.0 with Codex support

- 2026-11-17T07:07:47.577Z check: red (package.json, package-lock.json and both plugin manifests say 1.9.0, and CHANGELOG.md has a 1.9.0 entry)
- 2026-11-17T07:08:39.777Z check: green
- 2026-11-17T07:08:44.940Z dev@soundheart.io: codex/.codex-plugin/plugin.json (the mirror of codex/plugin.json for older Codex builds) still says 1.8.1: it is outside this job's files, so it is left for a follow-up job. Tag v1.9.0, the GitHub release and moving the installed gmod are after-landing steps, not done here.
- 2026-11-17T07:16:51.720Z dev@soundheart.io: npm test: 258 tests, 256 pass, 1 fail, 1 skipped. test/codex-plugin.test.mjs "both plugin manifests are gmod at the package version" requires codex/.codex-plugin/plugin.json (the legacy Codex manifest) to carry the package version, and that file is outside this job's files. Not committed: drafted edit_job adding codex/.codex-plugin/plugin.json to release-1-9's files, for the person to approve. After that, bump its version to 1.9.0 and commit.
- 2026-11-17T15:35:48.223Z check: green

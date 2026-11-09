# release-1-7-1: Release gmod 1.7.1 with the five follow-up fixes

- 2026-11-09T05:08:55.104Z check: red (package.json, package-lock.json and plugin.json all say 1.7.1, and CHANGELOG.md has a 1.7.1 entry)
- 2026-11-09T05:09:09.200Z check: red (package.json, package-lock.json and plugin.json all say 1.7.1, and CHANGELOG.md has a 1.7.1 entry)
- 2026-11-09T05:13:24.978Z check: green
- 2026-11-09T05:13:31.368Z dev@soundheart.io: The shell hook (1.7.0 mod) refused the changelog write because the quoted-heredoc text quoted a decide command in backticks, the very bug #73 fixes. With the person's go-ahead the changelog went in through the Edit tool; versions were bumped with npm version and sed.

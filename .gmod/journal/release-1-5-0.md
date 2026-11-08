# release-1-5-0: Release gmod 1.5.0 so repos can upgrade

- 2026-11-08T16:25:23.691Z check: red (package.json, package-lock.json and plugin.json all say 1.5.0, and CHANGELOG.md has a 1.5.0 entry)
- 2026-11-08T16:25:55.646Z check: red (package.json, package-lock.json and plugin.json all say 1.5.0, and CHANGELOG.md has a 1.5.0 entry)
- 2026-11-08T16:26:26.584Z check: green
- 2026-11-08T16:26:33.053Z dev@soundheart.io: The first red was only the missing test file (auto mode gave no verdict on the Write); a genuine red was recorded once it existed (1.4.7, no CHANGELOG). Versions bumped with `npm version 1.5.0 --no-git-tag-version` (package.json, package-lock.json root + packages[""]) and plugin.json by hand. CHANGELOG.md starts here, written plain-English first with the technical details under each point, as the person asked. After landing: push the v1.5.0 tag on the landed commit (image.yml checks it matches package.json) — asked of the person first.

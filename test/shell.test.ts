import { expect, test } from 'claude-code/testing'

import { decidesPlan, mergesPr, movesClaims, writesPlan, writesRecords } from '../hooks/shell'

test('reading the plan is never a write', () => {
  for (const cmd of [
    'cat .gmod/plan.json 2>/dev/null',
    'cat .gmod/plan.json 2>/dev/null || echo none',
    'jq . .gmod/plan.json > /tmp/plan.pretty',
    'cp .gmod/plan.json /tmp/',
    'sed -n 1,20p .gmod/plan.json',
    'git show HEAD:.gmod/plan.json',
    'git diff .gmod/plan.json',
    'grep -n slug .gmod/plan.json',
    'node -e "console.log(require(\'./.gmod/plan.json\'))"',
    'ls .gmod && cat .gmod/plan.json | head',
  ]) expect([cmd, writesPlan(cmd)]).toEqual([cmd, false])
})

test('the obvious writes to the plan are caught', () => {
  for (const cmd of [
    'echo {} > .gmod/plan.json',
    'cat new.json >> .gmod/plan.json',
    'jq ".jobs += []" p.json | tee .gmod/plan.json',
    "sed -i '' s/a/b/ .gmod/plan.json",
    'perl -pi -e s/a/b/ .gmod/plan.json',
    'cp /tmp/p.json .gmod/plan.json',
    'mv draft.json ./.gmod/plan.json',
    'rm .gmod/plan.json',
    'git checkout HEAD~1 -- .gmod/plan.json',
    'git restore .gmod/plan.json',
    'vim .gmod/plan.json',
  ]) expect([cmd, writesPlan(cmd)]).toEqual([cmd, true])
})

test("gmod's records: reads pass, writes are caught", () => {
  expect(writesRecords('cat .git/gmod/claim.json')).toBe(false)
  expect(writesRecords('ls .git/gmod/evidence/')).toBe(false)
  expect(writesRecords('echo [] > .git/gmod/evidence/add-sum.json')).toBe(true)
  expect(writesRecords('rm .git/gmod/proposal.json')).toBe(true)
  expect(writesRecords('cp x .git/worktrees/a/gmod/claim.json')).toBe(true)
})

test('claims and decisions', () => {
  expect(movesClaims('git push origin :refs/gmod/claims/x')).toBe(true)
  expect(movesClaims('git ls-remote origin refs/gmod/claims/*')).toBe(false)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs approve')).toBe(true)
  expect(decidesPlan("node '/x/gmod.mjs' reject 'no'")).toBe(true)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs proposal')).toBe(false)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs adr accept cents-only')).toBe(true)
  expect(decidesPlan('gmod adr reject cents-only "not now"')).toBe(true)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs adr propose {}')).toBe(false)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs adr list')).toBe(false)
})

test('merging a pull request by hand is caught; gmod pr --auto is not', () => {
  expect(mergesPr('gh pr merge 3 --merge')).toBe(true)
  expect(mergesPr('tea pr merge 3')).toBe(true)
  expect(mergesPr('curl -X POST -H "authorization: token $(cat ~/.config/gmod/gitea-token)" http://ai.local:3000/api/v1/repos/acme/gtrader/pulls/3/merge -d \'{"Do":"merge"}\'')).toBe(true)
  expect(mergesPr('node ~/gmod/bin/gmod.mjs pr --auto')).toBe(false)
  expect(mergesPr('git merge origin/main')).toBe(false)
  expect(mergesPr('curl http://ai.local:3000/api/v1/repos/acme/gtrader/pulls/3')).toBe(false)
  expect(mergesPr("git commit -m 'pr --auto: like gh pr merge --auto, the forge merges on green (a POST to /pulls/4/merge)'")).toBe(false)
  expect(mergesPr('cd x && gh pr merge 3')).toBe(true)
})

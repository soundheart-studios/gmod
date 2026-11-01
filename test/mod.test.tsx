import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// The engine beneath the mod is stubbed: `gmod` answers as the CLI would.
type Answer = { exitCode: number; stdout: string; stderr?: string }

type Seen = { runs: { args: readonly string[]; cwd?: string }[]; calls: Record<string, unknown>[] }

function engine(on: On, answer: (args: readonly string[]) => Answer): Seen {
  const seen: Seen = { runs: [], calls: [] }
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(2)
    seen.runs.push({ args, cwd: e.init?.cwd })
    const a = answer(args)
    return { value: { exitCode: a.exitCode, stdout: a.stdout, stderr: a.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => {
    seen.calls.push(e as unknown as Record<string, unknown>)
    return { result: 'ran' }
  })
  return seen
}

const JOB = (over: Record<string, unknown>) => ({
  goal: 'A job', state: 'ready', stage: 0, stalled: false, tests: 'none', where: null, waiting: [], after: [],
  criteria: [{ text: 'it works', pass: null }], files: ['src/x.mjs'], ...over,
})

const STATUS = JSON.stringify({
  governed: true,
  claim: { job: 'add-sum', goal: 'Add two numbers', files: ['src/**', 'test/**'], done_when: ['sum adds'] },
  evidence: [{ result: 'red', at: '2026-10-31T10:00:00Z', failed: ['sum adds'] }],
  sawRed: true,
  gate: { ok: false, reason: 'add-sum: the last check failed' },
  jobs: [
    JOB({ id: 'slugify', goal: 'Turn a title into a slug', state: 'done', stage: 6, tests: 'green' }),
    JOB({ id: 'add-sum', goal: 'Add two numbers', state: 'claimed', stage: 2, stalled: true, tests: 'red', by: 'alice@x.io', where: 'agent-1', criteria: [{ text: 'sum adds', pass: false }] }),
    JOB({ id: 'add-mul', state: 'waiting', waiting: ['add-sum'], after: ['add-sum'] }),
  ],
  next: null,
  proposal: {
    by: 'alice@x.io',
    at: '2026-10-31T10:05:00Z',
    summary: 'add slug-trim; change add-mul',
    headline: 'Slugs stay short enough for a URL.',
    assumptions: ['40 characters at most'],
    stale: false,
    diff: {
      added: [{ id: 'slug-trim', goal: 'Keep slugs short', after: ['add-sum'], criteria: ['a long title fits in 40'], files: 1, tests: 1, paths: ['src/trim.mjs', 'test/trim.test.mjs'] }],
      changed: [{ id: 'add-mul', goal: 'Multiply', after: [], criteria: [], files: 1, tests: 1, paths: ['src/mul.mjs'], fields: ['goal'], changes: [{ field: 'goal', before: 'Multiply', after: 'Multiply two numbers' }] }],
      dropped: [],
      checks: ['trim'],
      phases: { added: [], changed: [], dropped: [] },
    },
    order: [{ id: 'slug-trim', after: ['add-sum'], waits: ['add-sum'], now: false }],
    warnings: ['slug-trim lists no test files'],
    ready: true,
  },
})

test('an edit outside the claimed job is refused with the reason', async ($, on) => {
  engine(on, args => (args[0] === 'guard-path' && args[1] === 'README' ? { exitCode: 1, stdout: 'README is outside add-sum' } : { exitCode: 0, stdout: 'ok' }))
  const out = await $.tool.call({ tool: 'Edit', file_path: 'README', old_string: 'a', new_string: 'b' })
  expect(out.deny).toContain('README is outside add-sum')
  const inside = await $.tool.call({ tool: 'Edit', file_path: 'src/sum.mjs', old_string: 'a', new_string: 'b' })
  expect(inside.deny).toBeUndefined()
})

test('a commit runs behind the gate, in the shell that commits', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  await $.tool.call({ tool: 'Bash', command: 'cd ../wt && git add -A && git commit -m "add-sum: x"' })
  const ran = String(seen.calls.at(-1)?.command)
  expect(ran).toContain('gate-commit --shell || return 1')
  expect(ran.endsWith('cd ../wt && git add -A && git commit -m "add-sum: x"')).toBe(true)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(seen.calls.at(-1)?.command).toBe('ls')
})

test('an edit is judged by the repository the file is in', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: 'ok' }))
  await $.tool.call({ tool: 'Write', file_path: '/repo-wt/src/a.mjs', content: 'x' })
  expect(seen.runs.find(r => r.args[0] === 'guard-path')?.args[1]).toBe('/repo-wt/src/a.mjs')
})

test('the agent drafts, never decides', async ($, on) => {
  const seen = engine(on, args => (args[0] === 'propose-job' ? { exitCode: 0, stdout: 'drafted: add slug-trim' } : { exitCode: 0, stdout: STATUS }))
  const job = { id: 'slug-trim', goal: 'Trim', files: ['src/**'], done_when: [{ text: 't', check: 'trim' }] }
  const out = await $.tool.call({ tool: 'mcp__gmod__propose_job', job, checks: { trim: 'node t.mjs' } } as never)
  expect(String(out.result)).toContain('/gmod approve')
  const run = seen.runs.find(r => r.args[0] === 'propose-job')!
  expect(JSON.parse(String(run.args[1])).id).toBe('slug-trim')
  expect(run.args.slice(2)).toEqual(['--checks', '{"trim":"node t.mjs"}'])
  expect((await $.tool.call({ tool: 'Bash', command: 'node ~/gmod/bin/gmod.mjs approve' })).deny).toContain("person's decision")
  expect((await $.command.run({ command: 'gmod', args: 'approve' } as never)).text).toContain('Only a person')
  expect((await $.command.run({ command: 'gmod', args: 'reject' } as never)).text).toContain('Only a person')
})

test("gmod's own records can't be written from the shell", async ($, on) => {
  engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  expect((await $.tool.call({ tool: 'Bash', command: 'echo [] > .git/gmod/evidence/add-sum.json' })).deny).toContain('own records')
})

test('a subagent in a worktree works with its own folder', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: 'claimed docs' }))
  await $.tool.call({ tool: 'mcp__gmod__claim', job: 'docs', dir: '/repo-wt' } as never)
  expect(seen.runs.find(r => r.args[0] === 'claim')?.cwd).toBe('/repo-wt')
})

test('a subagent is told the routine when the repository is governed', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  on('command.register', () => ({ value: { command: 'gmod' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__gmod__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'work docs', prompt: 'Do the docs job.', subagent_type: 'general-purpose' })
  const prompt = String(seen.calls.at(-1)?.prompt)
  expect(prompt.startsWith('Do the docs job.')).toBe(true)
  expect(prompt).toContain('pass its path as "dir"')
})

test('the agent cannot move claims or rewrite the plan through the shell', async ($, on) => {
  engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin :refs/gmod/claims/add-sum' })).deny).toContain('claims change only')
  expect((await $.tool.call({ tool: 'Bash', command: "sed -i '' s/a/b/ .gmod/plan.json" })).deny).toContain('allow-plan')
})

test('only a person at the prompt allows plan edits', async ($, on) => {
  engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  const fromPlugin = await $.command.run({ command: 'gmod', args: 'allow-plan' } as never)
  expect(fromPlugin.text).toContain('Only a person')
})

const PANE = {
  plugin: 'gmod',
  component: 'Pane',
  requestId: 'gmod',
  surface: 'terminal',
  props: { title: 'gmod', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

async function started($: Engine, on: On, answer: (args: readonly string[]) => Answer) {
  const seen = engine(on, answer)
  on('command.register', () => ({ value: { command: 'gmod' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__gmod__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return seen
}

test('the pane: progress, what needs you, every job on its stage track', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /1 of 3 done · 1 in progress · 1 waiting/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Needs you$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /add-sum is red in agent-1/ })).toBeDefined()
  // claim test commit push merge: a header, then a column of dots each.
  for (const step of ['claim', 'test', 'commit', 'push', 'merge']) expect(await ui.find({ type: 'Text', text: new RegExp(`^${step}$`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ slugify$/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^●$/ })).length).toBe(5 + 2)
  // The right side says only who has it, or what it waits for.
  expect(await ui.find({ type: 'Text', text: /^agent-1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^after\u00a0add-sum$/ })).toBeDefined()
  // The test dot carries the color.
  const colors = (await ui.findAll({ type: 'Text', text: /^●$/ })).map(d => d.props?.color)
  expect(colors).toContain('red')
  // A row opens to its goal, criteria and files.
  expect(await ui.find({ type: 'Text', text: /✗ sum adds/ })).toBeUndefined()
  await ui.press({ key: 'rowadd-sum' })
  expect(await ui.find({ type: 'Text', text: /✗ sum adds/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claimed by alice@x\.io/ })).toBeDefined()
  await ui.unmount()
})

test('the proposal card is short: why, one line per job, the decision', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  const has = async (t: RegExp) => Boolean(await ui.find({ type: 'Text', text: t }))
  expect(await has(/Plan change: 1 new job, 1 changed/)).toBe(true)
  expect(await has(/^Slugs stay short enough for a URL\.$/)).toBe(true)
  expect(await has(/^\+ slug-trim$/)).toBe(true)
  expect(await has(/^Keep slugs short  after add-sum$/)).toBe(true)
  expect(await has(/^changes goal$/)).toBe(true)
  expect(await has(/^1 assumption ▸$/)).toBe(true)
  expect(await has(/! slug-trim lists no test files/)).toBe(true)
  // Detail stays folded until asked for.
  expect(await has(/a long title fits in 40/)).toBe(false)
  expect(await has(/40 characters at most/)).toBe(false)
  expect(await has(/drafted by/)).toBe(false)
  await ui.press({ key: 'cardslug-trim' })
  expect(await has(/◦ a long title fits in 40/)).toBe(true)
  expect(await has(/may change src\/trim\.mjs, test\/trim\.test\.mjs/)).toBe(true)
  await ui.press({ key: 'cardadd-mul' })
  expect(await has(/^Multiply two numbers$/)).toBe(true)
  await ui.press({ key: 'assumptions' })
  expect(await has(/· 40 characters at most/)).toBe(true)
  expect(await ui.findAll({ type: 'Button', text: /^(Approve|Suggest a change…|Reject)$/ })).toHaveLength(3)
  await ui.unmount()
})

test('in a narrow pane the names give way, and a note never splits', async ($, on) => {
  const narrow = JSON.parse(STATUS)
  narrow.jobs[1].where = 'agent 2'
  narrow.jobs[1].id = 'a-rather-long-job-name'
  await started($, on, () => ({ exitCode: 0, stdout: JSON.stringify(narrow) }))
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 50 } })
  // 50 columns: 3 + name + 34 for the steps + 7 for "agent 2" leaves 8 for the name.
  expect(await ui.find({ type: 'Text', text: /^◐ a-rathe…$/ })).toBeDefined()
  const note = await ui.find({ type: 'Text', text: /^agent\u00a02$/ })
  expect(note?.props?.wrap).toBe('truncate-end')
  await ui.unmount()
})

test('an opened row names every step, and how the test stands', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'rowadd-sum' })
  expect(await ui.find({ type: 'Text', text: /^✓ claim  ✗ test  ○ commit  ○ push  ○ merge/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^test: failing$/ })).toBeDefined()
  await ui.unmount()
})

test('Approve and Reject in the card are the person deciding', async ($, on) => {
  const seen = await started($, on, args => (args[0] === 'approve' ? { exitCode: 0, stdout: 'approved: add slug-trim (commit abc on main)' } : { exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'approve' })
  expect(seen.runs.some(r => r.args[0] === 'approve')).toBe(true)
  await ui.press({ key: 'reject' })
  expect(seen.runs.some(r => r.args[0] === 'reject')).toBe(true)
  await ui.unmount()
})

test('Ask for changes sends the note to Claude', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'ask' })
  await ui.input({ key: 'ask-note', text: 'use -1 suffixes' })
  expect(sent).toEqual(['Please revise the plan proposal: use -1 suffixes'])
  await ui.unmount()
})

test('reading the plan from the shell is not refused', async ($, on) => {
  engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  expect((await $.tool.call({ tool: 'Bash', command: 'cat .gmod/plan.json 2>/dev/null' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cat .git/gmod/claim.json' })).deny).toBeUndefined()
})

// The desktop app can run an older engine than the terminal: the pane must
// draw on every surface, with only props both accept.
for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`the pane draws on ${surface}`, async ($, on) => {
    engine(on, () => ({ exitCode: 0, stdout: STATUS }))
    on('command.register', () => ({ value: { command: 'gmod' } }))
    on('tool.register', (_, e) => ({ value: { tool: `mcp__gmod__${e.name}` } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.surfaces', () => ({ value: [surface] }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /1 of 3 done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Plan change/ })).toBeDefined()
    await ui.press({ key: 'rowadd-sum' })
    expect(await ui.find({ type: 'Text', text: /✗ sum adds/ })).toBeDefined()
    // The suggestion box opens on its own row, where the surface takes input.
    await ui.press({ key: 'ask' })
    if (surface !== 'mobile') {
      expect(await ui.find({ type: 'Text', text: /^What would you change\?/ })).toBeDefined()
      expect(await ui.find({ type: 'Input' })).toBeDefined()
    }
    await ui.unmount()
  })
}

// ---- phases ----

const PHASED = JSON.stringify({
  governed: true,
  claim: null,
  evidence: [],
  sawRed: false,
  gate: null,
  next: 'tag-index',
  phases: [
    { id: 'slugs', title: 'Slugs', outcome: 'Every post has its own URL', after: [], waiting: [], state: 'done', jobs: ['slugify'], done: 1, total: 1, moving: 0, stalled: false },
    { id: 'tags', title: 'Tags', outcome: 'Posts can be found by tag', after: ['slugs'], waiting: [], state: 'active', jobs: ['post-tags', 'tag-index'], done: 0, total: 2, moving: 1, stalled: false },
    { id: 'search', title: 'Search', outcome: 'Readers can search posts', after: ['tags'], waiting: ['tags'], state: 'waiting', jobs: ['search'], done: 0, total: 1, moving: 0, stalled: false },
  ],
  jobs: [
    JOB({ id: 'slugify', phase: 'slugs', state: 'done', stage: 6, tests: 'green' }),
    JOB({ id: 'post-tags', phase: 'tags', state: 'claimed', stage: 3, tests: 'green', where: 'agent 1' }),
    JOB({ id: 'tag-index', phase: 'tags', state: 'ready' }),
    JOB({ id: 'search', phase: 'search', state: 'waiting', waiting: ['post-tags', 'tag-index'] }),
  ],
  proposal: {
    by: 'alice@x.io', at: '2026-10-31T10:05:00Z', summary: 'add phase search; add search', headline: 'Readers can search.', assumptions: [], stale: false, ready: false,
    diff: {
      added: [{ id: 'search', goal: 'Search posts by word', phase: 'search', after: [], criteria: ['finds a word'], files: 1, tests: 1, paths: ['src/search.mjs'] }],
      changed: [], dropped: [], checks: [],
      phases: { added: [{ id: 'search', title: 'Search', outcome: 'Readers can search posts', after: ['tags'] }], changed: [], dropped: [] },
    },
    order: [], warnings: ['not ready to approve: job other isn\'t in a phase yet'],
  },
})

test('phases fold where the work isn\'t, and say where they stand', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: PHASED }))
  const ui = await $.ui.mount(PANE)
  const has = async (t: RegExp) => Boolean(await ui.find({ type: 'Text', text: t }))
  // Done: folded, with its count. Active: open, with its outcome and jobs.
  expect(await has(/^▸ Slugs$/)).toBe(true)
  expect(await has(/✓ 1 of 1/)).toBe(true)
  expect(await has(/^slugify/)).toBe(false)
  expect(await has(/^▾ Tags$/)).toBe(true)
  expect(await has(/0 of 2 · 1 in progress/)).toBe(true)
  expect(await has(/^Posts can be found by tag$/)).toBe(true)
  expect(await has(/^◐ post-tags$/)).toBe(true)
  // Search is in the proposal, so it opens though it waits.
  expect(await has(/^▾ Search$/)).toBe(true)
  expect(await has(/after tags/)).toBe(true)
  // Folding is the person's call.
  await ui.press({ key: 'phasetags' })
  expect(await has(/^◐ post-tags$/)).toBe(false)
  await ui.press({ key: 'phaseslugs' })
  expect(await has(/^✓ slugify$/)).toBe(true)
  await ui.unmount()
})

test('the card groups new jobs under their phase, and holds Approve until the draft is whole', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: PHASED }))
  const ui = await $.ui.mount(PANE)
  const has = async (t: RegExp) => Boolean(await ui.find({ type: 'Text', text: t }))
  expect(await has(/Plan change: 1 new phase, 1 new job/)).toBe(true)
  expect(await has(/^\+ Search$/)).toBe(true)
  expect(await has(/after Tags/)).toBe(true)
  expect(await has(/^\+ search$/)).toBe(true)
  expect(await has(/not ready to approve/)).toBe(true)
  expect(await ui.find({ type: 'Button', text: /^Approve$/ })).toBeUndefined()
  await ui.press({ key: 'cardphasesearch' })
  expect(await has(/^Readers can search posts$/)).toBe(true)
  await ui.unmount()
})

test('the agent drafts phases through its tools', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: 'drafted: add phase tags' }))
  const out = await $.tool.call({ tool: 'mcp__gmod__propose_phase', phase: { id: 'tags', outcome: 'Posts can be found by tag', after: ['slugs'] } } as never)
  expect(String(out.result)).toContain('add phase tags')
  expect(JSON.parse(String(seen.runs.find(r => r.args[0] === 'propose-phase')!.args[1])).after).toEqual(['slugs'])
  await $.tool.call({ tool: 'mcp__gmod__drop_phase', id: 'tags', reason: 'later' } as never)
  expect(seen.runs.find(r => r.args[0] === 'drop-phase')!.args).toEqual(['drop-phase', 'tags', '--reason', 'later'])
})

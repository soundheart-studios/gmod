export type GmodRun = { result: 'green' | 'red'; at: string; failed: string[] }
export type GmodJob = {
  id: string
  goal: string
  state: 'done' | 'claimed' | 'waiting' | 'ready'
  // 0 not started · 1 claimed · 2 red · 3 green · 4 committed · 5 pushed · 6 merged
  stage: number
  stalled: boolean
  tests: 'none' | 'red' | 'green' | 'unproven'
  by?: string
  where: string | null
  waiting: string[]
  after: string[]
  phase: string | null
  moved: { level: 'fresh' | 'behind' | 'touched' | 'conflicts' | 'breaks'; behind: number; landed: string[]; changed: string[]; touched: string[]; conflicts: string[]; failing: string[] } | null
  criteria: { text: string; pass: boolean | null }[]
  files: string[]
}
export type GmodJobCard = { id: string; goal: string; phase: string | null; after: string[]; criteria: string[]; files: number; tests: number; paths: string[] }
export type GmodPhaseCard = { id: string; title: string; outcome: string; after: string[] }
export type GmodPhase = {
  id: string
  title: string
  outcome: string
  after: string[]
  waiting: string[]
  state: 'done' | 'active' | 'ready' | 'waiting'
  jobs: string[]
  done: number
  total: number
  moving: number
  stalled: boolean
}
export type GmodDiff = {
  added: GmodJobCard[]
  changed: (GmodJobCard & { fields: string[]; changes: { field: string; before: string; after: string }[] })[]
  dropped: { id: string; goal: string; reason: string }[]
  checks: string[]
  phases: {
    added: GmodPhaseCard[]
    changed: (GmodPhaseCard & { fields: string[]; changes: { field: string; before: string; after: string }[] })[]
    dropped: (GmodPhaseCard & { reason: string })[]
  }
}
export type GmodProposal = {
  by: string
  at: string
  summary: string
  headline: string
  assumptions: string[]
  diff: GmodDiff
  order: { id: string; phase: string | null; after: string[]; waits: string[]; now: boolean }[]
  warnings: string[]
  stale: boolean
  ready: boolean
}
export type GmodStatus = {
  governed: boolean
  root?: string
  proposal?: GmodProposal | null
  phases?: GmodPhase[]
  claim?: { job: string; goal: string; files: string[]; done_when: string[]; brief?: string } | null
  evidence?: GmodRun[]
  sawRed?: boolean
  gate?: { ok: boolean; reason: string } | null
  jobs?: GmodJob[]
  next?: string | null
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    gmod: { status: Shaped<GmodStatus | null>; allowPlan: boolean; open: string | null; asking: boolean; cardOpen: string | null; showAssumptions: boolean; phaseOpen: Record<string, boolean> }
  }
}

// What a shell command does to gmod's files, read from its text. The rules
// live in lib/shell.mjs, plain JavaScript any host can run and node's own
// tests prove (test/shell-rules.test.mjs); this file gives them their types.

// @ts-ignore: plain JavaScript, shared with every host
import * as rules from '../lib/shell.mjs'

// Which of a person's decisions a command makes: 'plan' for gmod approve,
// reject, decide and adr accept|reject, 'managed' for gmod manage on|off.
export type Decision = 'plan' | 'managed'

export const writesPlan = rules.writesPlan as (cmd: string) => boolean
export const writesRecords = rules.writesRecords as (cmd: string) => boolean
export const movesClaims = rules.movesClaims as (cmd: string, depth?: number) => boolean
export const decidesPlan = rules.decidesPlan as (cmd: string) => boolean
export const decision = rules.decision as (cmd: string, depth?: number) => Decision | null
export const commitDirs = rules.commitDirs as (cmd: string) => string[]
export const commitsAlone = rules.commitsAlone as (cmd: string) => boolean
export const resolveDir = rules.resolveDir as (cwd: string, dir: string, home?: string) => string
export const mergesPr = rules.mergesPr as (cmd: string) => boolean

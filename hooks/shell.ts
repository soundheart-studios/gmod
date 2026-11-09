// What a shell command does to gmod's files, read from its text. Best
// effort: a shell can always find another way, and CI is the backstop. The
// point is to refuse the obvious writes without refusing reads like
// `cat .gmod/plan.json 2>/dev/null` or `jq . .gmod/plan.json > /tmp/x`.

const PLAN = String.raw`(?:\./)?\.gmod/plan\.json`
const RECORDS = String.raw`\S*\bgmod/(?:claim\.json|evidence/\S*|proposal\.json)`

// One simple command of a pipeline or list.
function pieces(cmd: string): string[] {
  return cmd.split(/\|\||&&|[;|\n]/).map(p => p.trim()).filter(Boolean)
}

function writes(cmd: string, target: string): boolean {
  const t = new RegExp(String.raw`(^|[\s'"=])${target}(?=$|[\s'";)])`)
  return pieces(cmd).some(p => {
    // Redirected into it: `> f`, `>> f`, `>| f`, `1> f`, `&> f`.
    if (new RegExp(String.raw`(?:^|[^<0-9&])\d?&?>{1,2}\|?\s*['"]?${target}(?=$|[\s'";)])`).test(p)) return true
    if (!t.test(p)) return false
    const [cmdName = '', ...args] = p.split(/\s+/)
    const name = cmdName.replace(/^.*\//, '')
    if (name === 'tee' || name === 'truncate' || name === 'rm' || name === 'unlink' || name === 'shred') return true
    if ((name === 'sed' || name === 'perl' || name === 'ruby') && args.some(a => /^-[a-zA-Z]*i/.test(a))) return true
    // mv / cp / install / ln / rsync with it as the destination (the last word).
    if (['mv', 'cp', 'install', 'ln', 'rsync', 'dd'].includes(name)) return new RegExp(String.raw`${target}['"]?$`).test(p) || /\bof=/.test(p)
    if (name === 'git') return /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|restore|mv|rm|apply|am|stash\s+pop)\b/.test(p)
    // Editors and scripted writes.
    if (['vi', 'vim', 'nvim', 'nano', 'emacs', 'ed', 'ex'].includes(name)) return true
    if ((name === 'node' || name === 'python' || name === 'python3') && /writeFile|open\([^)]*['"]w/.test(p)) return true
    return false
  })
}

export function writesPlan(cmd: string): boolean {
  return writes(cmd, PLAN)
}

export function writesRecords(cmd: string): boolean {
  return writes(cmd, RECORDS)
}

// Moving gmod's shared refs by hand: git update-ref, push, branch -D, tag or
// replace with a refs/gmod/ argument. Read word by word like decision(), so
// a sed's new text, a heredoc, a comment or a read (ls-remote) is not a move;
// sh -c, eval and the like are read too.
export function movesClaims(cmd: string, depth = 0): boolean {
  if (depth > 3) return false
  for (const words of lists(cmd)) {
    for (const w of words) {
      if (quotedDoc(w)) continue
      for (const m of w.matchAll(/\$\(([\s\S]*)\)|`([^`]*)`/g)) if (movesClaims(m[1] ?? m[2] ?? '', depth + 1)) return true
    }
    const { name, args } = simple(words)
    if (RUNNERS.includes(name)) {
      const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
      const doc = args.find(a => a.startsWith('<<'))
      // A shell reading its commands from a pipe: a mention anywhere counts.
      if (SHELLS.includes(name) && c < 0 && !doc && !args.some(a => !a.startsWith('-'))) {
        if (/refs\/gmod\//.test(cmd) && /\b(update-ref|push|branch\s+-D|tag|replace)\b/.test(cmd)) return true
        continue
      }
      const text = SHELLS.includes(name)
        ? c >= 0 ? (args.slice(c + 1).find(a => !a.startsWith('-')) ?? '') : doc?.replace(/^<<\S*/, '') ?? ''
        : args.join(' ')
      if (movesClaims(text, depth + 1)) return true
      continue
    }
    if (name !== 'git') continue
    const { sub, rest } = gitCall(args, '.')
    const moves = ['update-ref', 'push', 'tag', 'replace'].includes(sub) || (sub === 'branch' && rest.some(a => /^-[a-zA-Z]*D/.test(a) || a === '--delete'))
    if (moves && rest.some(a => a.includes('refs/gmod/'))) return true
  }
  return false
}

// A heredoc whose delimiter is quoted (<<'EOF', <<"EOF"): its body is text,
// with no $(…) or `…` run in it.
function quotedDoc(word: string): boolean {
  return word.startsWith("<<'")
}

// A person's decisions: approving or rejecting the plan or an ADR, and
// switching managed mode on or off (ADR 0001).
export function decidesPlan(cmd: string): boolean {
  return decision(cmd) !== null
}

// Which of a person's decisions a command makes: 'plan' for gmod approve,
// reject, decide and adr accept|reject, 'managed' for gmod manage on|off, null for
// none. Read word by word, so a quoted mention (grep, echo, a commit message)
// is text, not a command; `gmod manage` and `gmod manage status` only read.
// Text run through sh -c, eval, xargs, $(…) and the like is read too.
export type Decision = 'plan' | 'managed'

export function decision(cmd: string, depth = 0): Decision | null {
  if (depth > 3) return null
  let managed = false
  for (const words of lists(cmd)) {
    const d = decisionWords(words, depth)
    if (d === 'plan') return 'plan'
    if (d === 'managed') managed = true
    // A shell reading its commands from a pipe (`echo … | sh`): what it runs
    // can't be told from text, so a mention anywhere counts.
    const { name, args } = simple(words)
    if (SHELLS.includes(name) && !args.some(a => !a.startsWith('-') || /^-[a-zA-Z]*c/.test(a))) {
      if (SAYS_PLAN.test(cmd)) return 'plan'
      if (SAYS_MANAGED.test(cmd)) managed = true
    }
  }
  return managed ? 'managed' : null
}

const GMOD = /^(?:gmod|gmod\.mjs)$/
const LAUNCHERS = ['node', 'npx', 'bun', 'bunx', 'deno', 'tsx', 'pnpx']
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh']
// What a command says once nothing tells it apart from text: a shell reading
// its commands from a pipe.
const SAYS_PLAN = /\bgmod(?:\.mjs)?['"]?\s+(?:(?:adr\s+)?(?:approve|reject|accept)|decide)\b/
const SAYS_MANAGED = /\bgmod(?:\.mjs)?['"]?\s+manage\s+['"]?(?:on|off)\b/

function either(a: Decision | null, b: Decision | null): Decision | null {
  return a === 'plan' || b === 'plan' ? 'plan' : (a ?? b)
}

function decisionWords(words: string[], depth: number): Decision | null {
  // What $(…) and `…` run, wherever they sit.
  let inside: Decision | null = null
  for (const w of words)
    if (!quotedDoc(w)) for (const m of w.matchAll(/\$\(([\s\S]*)\)|`([^`]*)`/g)) inside = either(inside, decision(m[1] ?? m[2] ?? '', depth + 1))
  return either(inside, commandDecision(words, depth))
}

function commandDecision(words: string[], depth: number): Decision | null {
  const { name, args } = simple(words)
  if (RUNNERS.includes(name)) {
    if (depth > 3) return null
    const rest = args.filter(a => !a.startsWith('-'))
    if (name === 'eval' || name === 'watch') return decision(rest.join(' '), depth + 1)
    if (SHELLS.includes(name)) {
      // sh -c 'text': the text is the command; a heredoc's body is too.
      const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
      if (c >= 0) {
        const text = args.slice(c + 1).find(a => !a.startsWith('-'))
        return text === undefined ? null : decision(text, depth + 1)
      }
      const doc = args.find(a => a.startsWith('<<'))
      if (doc !== undefined) return decision(doc.replace(/^<<\S*/, ''), depth + 1)
      return null
    }
    // xargs, parallel, source: the words that follow are the command.
    return commandDecision(rest, depth + 1)
  }
  let rest: string[]
  if (GMOD.test(name)) rest = args
  else if (LAUNCHERS.includes(name)) {
    const at = args.findIndex(a => GMOD.test(a.replace(/^.*\//, '')))
    if (at < 0 || args.slice(0, at).some(a => !a.startsWith('-'))) return null
    rest = args.slice(at + 1)
  } else return null
  const [sub, how] = rest.filter(a => !a.startsWith('-'))
  // gmod decide <signal-id> <action>: every surface's way to approve, reject,
  // ask for changes or accept, so the same person's decision as approve.
  if (sub === 'approve' || sub === 'reject' || sub === 'decide') return 'plan'
  if (sub === 'adr' && (how === 'accept' || how === 'reject')) return 'plan'
  if (sub === 'manage' && (how === 'on' || how === 'off')) return 'managed'
  return null
}

// The words of a command, list by list: quotes and escapes respected, so a
// commit message or an echo that says `git commit` is one word, not a
// command; a comment ends at its line; $(…) and `…` stay inside their word.
function lists(cmd: string): string[][] {
  const out: string[][] = [[]]
  let word: string | null = null
  const end = () => {
    if (word !== null) out.at(-1)!.push(word)
    word = null
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (c === '\\' && i + 1 < cmd.length) {
      word = (word ?? '') + (cmd[i + 1] === '\n' ? '' : cmd[i + 1])
      i++
    } else if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      const stop = j < 0 ? cmd.length : j
      word = (word ?? '') + cmd.slice(i + 1, stop)
      i = stop
    } else if (c === '"') {
      let s = ''
      i++
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length) i++
        s += cmd[i]
        i++
      }
      word = (word ?? '') + s
    } else if ((c === '$' && cmd[i + 1] === '(') || c === '`') {
      // Kept whole: what runs inside is judged as text, not as a command here.
      let depth = 0
      let j = i
      if (c === '`') j = cmd.indexOf('`', i + 1)
      else
        for (j = i + 1; j < cmd.length; j++) {
          if (cmd[j] === '(') depth++
          else if (cmd[j] === ')' && --depth === 0) break
        }
      const stop = j < 0 ? cmd.length - 1 : Math.min(j, cmd.length - 1)
      word = (word ?? '') + cmd.slice(i, stop + 1)
      i = stop
    } else if (c === '#' && word === null) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++
    } else if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      // A heredoc: its body is text for the command, not commands. It is
      // kept as one word, `<<DELIM` plus the body, up to the closing line;
      // `<<'DELIM` when the delimiter is quoted and the body runs nothing.
      const m = cmd.slice(i).match(/^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/)
      const nl = cmd.indexOf('\n', i)
      if (!m || nl < 0) {
        word = (word ?? '') + c
        continue
      }
      const close = new RegExp(String.raw`\n[\t ]*${m[2]}[\t ]*(?=\n|$)`).exec(cmd.slice(nl))
      const stop = close ? nl + close.index + close[0].length : cmd.length
      end()
      out.at(-1)!.push(`<<${m[1] ? "'" : ''}${m[2]}${cmd.slice(i + m[0].length, stop)}`)
      i = stop - 1
    } else if (c === '&' && (cmd[i - 1] === '>' || (cmd[i + 1] === '>' && word === null))) {
      // Part of a redirection: 2>&1, >&2, &>file.
      word = (word ?? '') + c
    } else if (/[;&|()\n]/.test(c)) {
      end()
      if (out.at(-1)!.length) out.push([])
    } else if (/\s/.test(c)) {
      end()
    } else {
      word = (word ?? '') + c
    }
  }
  end()
  return out.filter(l => l.length)
}

// A path the way a shell would reach it from `base` (both as written: `.`,
// relative, absolute or under ~).
function within(base: string, dir: string): string {
  const path = /^[/~]/.test(dir) || base === '.' ? dir : `${base}/${dir}`
  const abs = path.startsWith('/')
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..' && parts.length && parts.at(-1) !== '..' && parts.at(-1) !== '~') parts.pop()
    else if (!(p === '..' && abs && !parts.length)) parts.push(p)
  }
  return (abs ? '/' : '') + parts.join('/') || (abs ? '/' : '.')
}

// Where each `git commit` in a command runs, as written from the command's
// start: `.`, `../wt`, `/abs`, `~/x`. Follows `cd` along the command and
// `git -C`. Empty when the command commits nothing, whatever words it says.
export function commitDirs(cmd: string): string[] {
  const dirs: string[] = []
  let here = '.'
  for (const words of lists(cmd)) {
    const { name, args } = simple(words)
    if (name === 'cd' || name === 'pushd') here = within(here, args.find(a => !a.startsWith('-')) ?? '~')
    else if (name === 'git') {
      const { dir, sub } = gitCall(args, here)
      if (sub === 'commit' && !dirs.includes(dir)) dirs.push(dir)
    }
  }
  return dirs
}

// A simple command's name and arguments, past `FOO=1` and `command`/`env`.
function simple(words: string[]): { name: string; args: string[] } {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
  while (i < words.length && ['command', 'exec', 'time', 'nice', 'env'].includes(words[i]!)) {
    i++
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
  }
  return { name: (words[i] ?? '').replace(/^.*\//, ''), args: words.slice(i + 1) }
}

// A git call's subcommand and the directory it runs in (git -C).
function gitCall(args: string[], here: string): { dir: string; sub: string; rest: string[] } {
  let dir = here
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(a)) {
      if (a === '-C' && args[k + 1] !== undefined) dir = within(dir, args[k + 1]!)
      k++
    } else if (!a.startsWith('-')) return { dir, sub: a, rest: args.slice(k + 1) }
  }
  return { dir, sub: '', rest: [] }
}

// Git that changes no file in the worktree: what may sit beside a commit.
const QUIET_GIT = ['add', 'commit', 'status', 'diff', 'log', 'show', 'rev-parse']
// What runs a command given as text: a commit inside is out of the gate's sight.
const RUNNERS = ['eval', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'xargs', 'source', '.', 'parallel', 'watch']
const COMMITS = /\bgit\b[\s\S]*\bcommit\b/

// A redirection that writes a file (not /dev/null, not another descriptor).
function writesFile(words: string[]): boolean {
  for (let k = 0; k < words.length; k++) {
    const m = words[k]!.match(/^(?:\d*|&)>{1,2}\|?(.*)$/)
    if (!m) continue
    const to = m[1] || words[k + 1] || ''
    if (!/^(?:\/dev\/null|&\d|&-)$/.test(to)) return true
  }
  return false
}

// A $(…) or `…` inside a word that does more than print text: only cat and
// printf (a heredoc message) are let through, and never with a redirection.
function runsMore(words: string[]): boolean {
  return words.some(w => {
    for (const m of w.matchAll(/\$\(([\s\S]*)\)|`([^`]*)`/g)) {
      const inner = (m[1] ?? m[2] ?? '').trim()
      const head = inner.split('<<')[0]!
      if (!/^(?:cat|printf)\b/.test(inner) || />/.test(head)) return true
    }
    return false
  })
}

// Whether a command commits on its own: when it runs `git commit`, beside it
// there is only cd and git that changes no file, so what is committed is
// what the gate saw before the command ran. A commit run through eval, sh -c,
// xargs or a function is never on its own. A command that commits nothing is.
export function commitsAlone(cmd: string): boolean {
  const all = lists(cmd)
  if (/\(\s*\)\s*\{/.test(cmd) && COMMITS.test(cmd)) return false
  if (all.some(words => RUNNERS.includes(simple(words).name) && COMMITS.test(simple(words).args.join(' ')))) return false
  if (!commitDirs(cmd).length) return true
  return all.every(words => {
    const { name, args } = simple(words)
    if (name === 'cd' || name === 'pushd' || name === 'popd') return !writesFile(args)
    if (name !== 'git') return false
    const { sub } = gitCall(args, '.')
    return QUIET_GIT.includes(sub) && !writesFile(args) && !runsMore(args)
  })
}

// The directory a `commitDirs` entry names, seen from the session's cwd.
export function resolveDir(cwd: string, dir: string, home?: string): string {
  const d = home && /^~(\/|$)/.test(dir) ? home + dir.slice(1) : dir
  return within(cwd, d)
}

// Merging a pull request by hand: the forge's CLI or its merge endpoint. An
// agent hands a job over with gmod pr --auto, which lets the forge merge it
// once the gate (and the review) pass, and never a plan, ADR or CI change.
export function mergesPr(cmd: string): boolean {
  // Commands, not prose: a commit message may name the endpoint or the CLI.
  const calls = /(?:^|[;&|(]\s*)(?:curl|wget|http|xh)\b/m.test(cmd) || /\bfetch\(/.test(cmd)
  return /(?:^|[;&|(]\s*)(?:gh|tea|glab)\s+(?:pr|pulls?|mr)\s+merge\b/m.test(cmd) || (calls && /\/pulls\/\d+\/merge\b/.test(cmd))
}

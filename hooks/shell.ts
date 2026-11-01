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

export function movesClaims(cmd: string): boolean {
  return /refs\/gmod\//.test(cmd) && /\b(update-ref|push|branch\s+-D|tag|replace)\b/.test(cmd)
}

export function decidesPlan(cmd: string): boolean {
  return /\bgmod(?:\.mjs)?['"]?\s+(?:adr\s+)?(?:approve|reject|accept)\b/.test(cmd)
}

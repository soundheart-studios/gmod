// A Claude Code session keeps the mod it started with, and the mod runs its
// own copy of gmod. Once gmod is upgraded on this machine (the pin moved),
// an open session goes on with the old one: the 1.6 mod looked for a
// proposal where 1.7 no longer keeps it and said there was none. Comparing
// the mod's version with the gmod on the PATH lets it say to restart instead.

// "gmod 1.7.0" or "gmod 1.7.0 (abc123)" → [1, 7, 0]; anything else → null.
export function versionOf(out: string): number[] | null {
  const m = /^gmod (\d+)\.(\d+)\.(\d+)\b/.exec(out.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

// What to tell the person, or null when the mod is as new as the CLI (or
// either version can't be read: best effort, never a false alarm).
export function upgradeNotice(modOut: string, cliOut: string): string | null {
  const mod = versionOf(modOut)
  const cli = versionOf(cliOut)
  if (!mod || !cli || !newer(cli, mod)) return null
  return `gmod ${cli.join('.')} is installed: restart Claude Code to load it`
}

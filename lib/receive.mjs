// gmod receive: a server-side pre-receive hook that guards claims. Branches
// are none of its business (main is protected by the forge); claims are refs
// no branch protection covers. A claim is created freely (git itself refuses
// a second one), never moved, and let go only by its holder or an admin.
//
// Gitea runs every script in <repo>.git/hooks/pre-receive.d/ and tells it the
// pusher: GITEA_PUSHER_EMAIL, GITEA_PUSHER_NAME. Admins (the repo's owner, the
// CI bot that sweeps finished claims) come from GMOD_CLAIM_ADMINS.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GmodError, git } from './core.mjs';

const CLAIMS = 'refs/gmod/claims/';
const zero = sha => /^0+$/.test(sha);

export function receive(input, env = process.env, cwd = process.cwd()) {
  const email = (env.GITEA_PUSHER_EMAIL ?? '').toLowerCase();
  const name = env.GITEA_PUSHER_NAME ?? '';
  const admins = (env.GMOD_CLAIM_ADMINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const isAdmin = admins.includes(name.toLowerCase()) || (email && admins.includes(email));
  const refused = [];
  for (const line of input.split('\n')) {
    const [oldSha, newSha, ref] = line.trim().split(/\s+/);
    if (!ref?.startsWith(CLAIMS)) continue;
    const id = ref.slice(CLAIMS.length);
    if (zero(oldSha)) continue;
    if (!zero(newSha)) {
      refused.push(`claims don't move: release ${id} and claim it again`);
      continue;
    }
    let by = '';
    try {
      by = String(JSON.parse(git(['log', '-1', '--format=%B', oldSha], { cwd })).by ?? '');
    } catch {
      // A claim we can't read is let go only by an admin.
    }
    if (isAdmin || (by && by.toLowerCase() === email)) continue;
    refused.push(`${id} is claimed by ${by || 'someone'}: only they, or an admin, let it go`);
  }
  return { ok: !refused.length, refused };
}

// Install the hook into a bare repository on the forge's machine.
export function guardClaims({ repoPath, admins = [], gmod }) {
  const repo = resolve(repoPath);
  if (!existsSync(join(repo, 'hooks'))) throw new GmodError(`${repo} isn't a bare repository with hooks/`);
  const dir = join(repo, 'hooks', 'pre-receive.d');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gmod-claims');
  const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      "# gmod: claims are created freely, never moved, and let go only by their holder or an admin.",
      // node by its full path: the forge runs hooks with its own PATH, and a
      // hook that can't start refuses every push.
      `GMOD_CLAIM_ADMINS=${quote(admins.join(','))} exec ${quote(process.execPath)} ${quote(gmod)} receive`,
      '',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
  return { file, repo, admins };
}

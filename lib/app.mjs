// A GitHub App's installation token, for one run: what gmod does on GitHub
// then comes from the App (e.g. "gmod-agent[bot]"), not from CI's own token.
// Pull requests it opens and branches it updates start runs like a person's
// do, so gmod needs no repository_dispatch to start them, and GitHub leaves
// no empty runs behind (docs/notes/ci-token-ghost-runs.md).
import { createSign } from 'node:crypto';

export function appJwt(appId, key, now = Math.floor(Date.now() / 1000)) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  // Issued a minute back for clock drift, valid under GitHub's ten minutes.
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url')}`;
}

export async function appToken({ appId, key, repo, api = 'https://api.github.com' }) {
  const headers = { authorization: `Bearer ${appJwt(appId, key)}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const inst = await fetch(`${api}/repos/${repo}/installation`, { headers });
  if (!inst.ok) throw new Error(`the gmod App isn't installed on ${repo} (${inst.status}): install it from the App's page`);
  const { id } = await inst.json();
  const tok = await fetch(`${api}/app/installations/${id}/access_tokens`, { method: 'POST', headers });
  if (!tok.ok) throw new Error(`GitHub wouldn't give the App a token (${tok.status}): ${await tok.text()}`);
  return (await tok.json()).token;
}

// What an App for gmod needs, as a GitHub App manifest: create it in one
// click (POST to https://github.com/settings/apps/new), then trade the code
// GitHub returns for its ID and key (POST /app-manifests/<code>/conversions).
export function appManifest({ name, owner, url = 'https://github.com/soundheart-studios/gmod' }) {
  return {
    name,
    url,
    description: `gmod for ${owner}: gates, reviews and lands pull requests; agents in CI open them.`,
    public: false,
    redirect_url: url,
    hook_attributes: { url, active: false },
    default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', statuses: 'write', actions: 'read', metadata: 'read' },
    default_events: [],
  };
}

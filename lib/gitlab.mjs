// GitLab: the API, through glab (the person's login) on a machine, or a
// token in CI; what main's protection means there; and the CI component's
// include line.
//
// GitLab Free has no required named checks (that is Ultimate) and no merge
// trains (Premium). So on GitLab, "nothing merges unproven" is:
//   - main is protected: nobody pushes to it, nobody force-pushes;
//   - a merge request merges only if its pipeline succeeded, and never on a
//     skipped one; the gate and the review are jobs in that pipeline;
//   - merges are semi-linear ("merge commit with semi-linear history"): a
//     branch behind main can't merge, which is "up to date" on GitHub.
import { spawnSync } from 'node:child_process';
import { GmodError } from './core.mjs';

export const COMPONENT = 'soundheart-studios/gmod';
export const CI_FILE = '.gitlab-ci.yml';
// The pipeline jobs that stand for gate and review.
export const JOB = { gate: 'gmod-gate', review: 'gmod-review' };

export function glab(args, input) {
  // GMOD_GLAB: another glab, for tests.
  const r = spawnSync(process.env.GMOD_GLAB || 'glab', args, { input, encoding: 'utf8' });
  if (r.error) throw new GmodError('glab (the GitLab CLI) is needed for GitLab: https://gitlab.com/gitlab-org/cli');
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

export const projectId = forge => encodeURIComponent(forge.path ?? `${forge.owner}/${forge.repo}`);

// One call to GitLab's REST API (v4): with a token when there is one (CI),
// else through glab, signed in as the person. { ok, status, json }.
export async function gitlabApi(forge, method, path, body, { token } = {}) {
  if (token) {
    const res = await fetch(`${forge.api}${path}`, {
      method,
      headers: { 'private-token': token, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { text }; }
    return { ok: res.ok, status: res.status, json };
  }
  const args = ['api', '--hostname', forge.host, '-X', method, path.replace(/^\//, '')];
  const r = glab(body ? [...args, '--input', '-'] : args, body ? JSON.stringify(body) : undefined);
  let json = null;
  try { json = r.out ? JSON.parse(r.out) : null; } catch { json = { text: r.out }; }
  // glab says the status in its error: "... 404 Not Found"
  const status = r.ok ? 200 : Number(r.err.match(/\b([45]\d\d)\b/)?.[1] ?? 0);
  return { ok: r.ok, status, json: r.ok ? json : { message: r.err.trim() || r.out.trim() } };
}

// The settings gmod puts on a project, and checks are still there.
export const MERGE_SETTINGS = up => ({
  only_allow_merge_if_pipeline_succeeds: true,
  allow_merge_on_skipped_pipeline: false,
  ...(up ? { merge_method: 'rebase_merge' } : {}),
});

export async function gitlabProtect({ forge, main = 'main', upToDate = true, token }) {
  const id = projectId(forge);
  const s = await gitlabApi(forge, 'PUT', `/projects/${id}`, MERGE_SETTINGS(upToDate), { token });
  if (!s.ok) throw new GmodError(`GitLab refused the merge settings (${s.status}): ${JSON.stringify(s.json)}`);
  // Free GitLab can't edit a protected branch's levels in place: take the
  // old rule off and put gmod's on, back to back.
  const now = await gitlabApi(forge, 'GET', `/projects/${id}/protected_branches/${encodeURIComponent(main)}`, null, { token });
  if (now.ok && !protectedOk(now.json)) await gitlabApi(forge, 'DELETE', `/projects/${id}/protected_branches/${encodeURIComponent(main)}`, null, { token });
  if (!now.ok || !protectedOk(now.json)) {
    const p = await gitlabApi(forge, 'POST', `/projects/${id}/protected_branches`, { name: main, push_access_level: 0, merge_access_level: 30, allow_force_push: false }, { token });
    if (!p.ok) throw new GmodError(`GitLab refused to protect ${main} (${p.status}): ${JSON.stringify(p.json)}`);
  }
}

const protectedOk = b => !!b && (b.push_access_levels ?? []).every(l => l.access_level === 0 && !l.user_id && !l.group_id && !l.deploy_key_id) && !b.allow_force_push;

// Does main hold what .gmod/protect.json declares? { ok, msg }.
export async function gitlabProtection({ forge, spec, main = 'main', token }) {
  const id = projectId(forge);
  const p = await gitlabApi(forge, 'GET', `/projects/${id}`, null, { token });
  const b = await gitlabApi(forge, 'GET', `/projects/${id}/protected_branches/${encodeURIComponent(main)}`, null, { token });
  if (!p.ok) return { ok: false, msg: `couldn't read the project's merge settings (${p.status}), so ${main} can't be held to .gmod/protect.json` };
  const missing = [];
  if (!p.json.only_allow_merge_if_pipeline_succeeds) missing.push('merge requests can merge without a passing pipeline');
  if (p.json.allow_merge_on_skipped_pipeline) missing.push('a skipped pipeline counts as passing');
  if (spec.up_to_date && !['rebase_merge', 'ff'].includes(p.json.merge_method)) missing.push(`branches needn't be up to date (merge method ${p.json.merge_method})`);
  if (b.status === 404) missing.push(`${main} isn't protected`);
  else if (!b.ok) return { ok: false, msg: `couldn't read ${main}'s protection (${b.status}): the token needs the Maintainer role` };
  else {
    if ((b.json.push_access_levels ?? []).some(l => l.access_level !== 0 || l.user_id || l.group_id || l.deploy_key_id)) missing.push('direct pushes are allowed');
    if (b.json.allow_force_push) missing.push('force pushes are allowed');
  }
  return missing.length
    ? { ok: false, msg: `${main}'s protection is weaker than .gmod/protect.json: ${missing.join(', ')} (gmod ci protect puts it back)` }
    : { ok: true, msg: `${main}'s protection holds .gmod/protect.json (${spec.require.join(' and ')} in a pipeline that must pass)` };
}

// The lines a project's .gitlab-ci.yml needs: the component, pinned.
export function componentInclude({ ref, host = 'gitlab.com', project = COMPONENT, reviewer = { kind: 'none' }, blocking = true, setup = '' }) {
  const inputs = [];
  if (reviewer.url) {
    inputs.push(`      reviewer-url: ${reviewer.url}`);
    if (reviewer.model) inputs.push(`      reviewer-model: ${reviewer.model}`);
  }
  inputs.push(`      review: ${reviewer.kind === 'none' ? 'off' : blocking ? 'blocking' : 'advice'}`);
  if (setup) inputs.push(`      setup: ${JSON.stringify(setup)}`);
  return [
    '# gmod: gates, reviews and lands every merge request; after each landing,',
    '# checks what landed and catches the other job branches up. Written by',
    '# gmod setup; gmod ci upgrade moves it to a newer release.',
    'include:',
    `  - component: ${host}/${project}/gmod@${ref}`,
    '    inputs:',
    ...inputs,
    '',
  ].join('\n');
}

// Put the include into an existing .gitlab-ci.yml (or start one). An existing
// top-level include: list gets the component added to it.
export function withComponent(existing, block) {
  const text = existing ?? '';
  const re = new RegExp(`^  - component: [^\\n]*/gmod@\\S+\\n(?:      .*\\n|    inputs:\\n)*`, 'm');
  const item = block.slice(block.indexOf('  - component:'));
  if (re.test(text)) return text.replace(re, item);
  if (/^include:\s*$/m.test(text)) return text.replace(/^include:\s*\n/m, `include:\n${item}`);
  if (/^include:/m.test(text)) throw new GmodError(`${CI_FILE} has an include: gmod can't add to in place; add this to it by hand:\n${item}`);
  return text ? `${block}\n${text}` : block;
}

// gmod decide <signal-id> <action>: the one action command every surface
// uses for a person's decisions (ADR 0002, docs/surfaces.md): the CLI, Skiff,
// Linear, a person at another agent's terminal. It finds the signal by its
// stable id and does only what that signal offers:
//
//   plan proposal   approve | ask-changes (--note) | reject
//   ADR draft       accept | reject
//   agent's request answer (--note) | resolve [--note]
//   red job, moved  resolve [--note]: set it aside until it changes; otherwise
//                   the answer is the command to run (not a decision)
//
// Only a person decides. decide refuses under gmod's agent identity or an
// agent's environment; in a terminal it asks the person to type the signal's
// id back; without one, the surface that asked must name itself (--via). This
// keeps an agent from deciding by accident or habit; it can't stop a program
// that runs as the person and hides what it is (docs/limits.md). Every
// decision commit carries Decided-By and Decided-Via.
import * as adr from './adr.mjs';
import { AGENT } from './agent.mjs';
import * as core from './core.mjs';
import * as requests from './requests.mjs';
import { isAgent } from './managed.mjs';
import { signalsFrom } from './signals.mjs';
import { stamp } from './stamp.mjs';

// The environments an agent runs in, as each sets them.
const AGENT_ENV = [
  [/^CLAUDECODE$/, 'Claude Code'],
  [/^CLAUDE_CODE_ENTRYPOINT$/, 'Claude Code'],
  [/^CODEX_/, 'Codex'],
  [/^PI_AGENT$/, 'pi'],
  [/^GMOD_AGENT$/, 'a gmod agent'],
  [/^(CI|GITHUB_ACTIONS|GITLAB_CI|GITEA_ACTIONS)$/, 'CI'],
];

// Why this can't be a person's decision, or null when nothing says so.
export function agentReason(root, env = process.env) {
  if (isAgent(root)) return AGENT.name;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === '' || value === '0' || value === 'false') continue;
    const hit = AGENT_ENV.find(([re]) => re.test(key));
    if (hit) return `${hit[1]} (${key} is set)`;
  }
  return null;
}

// What to run for a signal that isn't a decision.
function hint(s) {
  if ('stuck' in s.cause) return `open ${s.cause.stuck}'s worktree: its criteria fail (gmod check there)`;
  if ('moved' in s.cause) return `rebase gmod/${s.cause.moved} onto main, then gmod check`;
  return 'nothing for gmod decide to do';
}

// `confirm(signal)` asks the person in a terminal; resolve true to go on.
export async function decide(root, id, action, { rev, note, via, tty = false, confirm, env = process.env } = {}) {
  const why = agentReason(root, env);
  if (why) throw new core.GmodError(`only a person decides, and this runs under ${why}: decide in the gmod pane or at your own terminal`);
  core.syncClaims(root);
  const status = core.status(root, { sync: false });
  const s = signalsFrom(status).find(x => x.id === id);
  if (!s) throw new core.GmodError(`no signal ${id} waiting (gmod signals)`);
  const setAside = s.kind === 'unstick' && action === 'resolve';
  if (s.kind !== 'decide' && !setAside) return { id, action, decided: false, hint: hint(s), stamp: stamp(root) };
  if (!s.actions.includes(action)) throw new core.GmodError(`"${action}" isn't offered for this: ${s.actions.join(', ')}`);
  if ('proposal' in s.cause && rev && rev !== s.rev) throw new core.GmodError(`the proposal changed since you saw it (rev ${rev}, now ${s.rev}): look at it again`);
  if (!tty && !via) throw new core.GmodError('without a terminal, name the surface that decides: --via <surface> (skiff, linear, …)');
  if (tty && !via && !(await confirm?.(s))) throw new core.GmodError('not confirmed: nothing was decided');
  via ??= 'cli';

  let result;
  if (setAside) {
    result = core.resolveSignal(root, s, note ?? '', { via });
  } else if ('proposal' in s.cause) {
    if (action === 'approve') result = core.approve(root, { via });
    else if (action === 'reject') result = core.reject(root, note ?? '');
    else result = core.askChanges(root, note, { via });
  } else if ('request' in s.cause) {
    const rid = s.cause.request;
    result = action === 'answer' ? requests.answer(root, rid, note, { via }) : requests.resolve(root, rid, note ?? '', { via });
  } else {
    const slug = s.cause.adr;
    result = action === 'accept' ? adr.acceptAdr(root, slug, { via }) : adr.rejectAdr(root, slug, note ?? '');
  }
  return { id, action, decided: true, via, by: core.who(root), question: s.question, result, stamp: stamp(root) };
}

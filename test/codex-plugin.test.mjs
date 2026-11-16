// The Codex plugin (codex/): its manifests parse, run the gmod CLI from PATH
// (`gmod mcp`, `gmod hook codex`), and its skills name only tools the MCP
// server serves (lib/mcp.mjs) and nothing Codex lacks (the pane, slash commands).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../lib/mcp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX = join(ROOT, 'codex');
const json = p => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const SKILLS = ['plan', 'work', 'adr', 'ci'];
const VERSION = json('package.json').version;

test('every manifest parses', () => {
  for (const p of ['codex/plugin.json', 'codex/.codex-plugin/plugin.json', 'codex/mcp.json', 'codex/hooks/hooks.json', '.agents/plugins/marketplace.json']) {
    assert.doesNotThrow(() => json(p), p);
  }
});

test('both plugin manifests are gmod at the package version', () => {
  for (const p of ['codex/plugin.json', 'codex/.codex-plugin/plugin.json']) {
    const m = json(p);
    assert.equal(m.name, 'gmod', p);
    assert.equal(m.version, VERSION, p);
    assert.match(m.description, /PATH/, `${p} says gmod runs from PATH`);
  }
  const m = json('codex/plugin.json');
  assert.equal(m.extensions['com.openai'].hooks, './hooks/hooks.json');
  assert.ok(m.extensions['com.openai'].interface.displayName);
  const legacy = json('codex/.codex-plugin/plugin.json');
  assert.equal(legacy.skills, './skills/');
  assert.equal(legacy.hooks, './hooks/hooks.json');
});

test('the MCP server runs gmod mcp', () => {
  const s = json('codex/mcp.json').mcpServers.gmod;
  assert.equal(s.command, 'gmod');
  assert.deepEqual(s.args, ['mcp']);
});

// codex exec with approval_policy never refuses every unapproved MCP call, and
// interactively the person would be asked on each one. gmod's tools enforce
// their own rules and none decides for the person, so they're approved by default.
test('the gmod server approves its tools by default', () => {
  const s = json('codex/mcp.json').mcpServers.gmod;
  assert.equal(s.default_tools_approval_mode, 'approve');
});

test('the Codex work skill stops on a refusal the job needs, and skips a refused tool it does not', () => {
  const text = readFileSync(join(CODEX, 'skills', 'work', 'SKILL.md'), 'utf8');
  const rule = text.split('\n').find(l => /denied/i.test(l) && /stop/i.test(l));
  assert.ok(rule, 'the work skill has a rule about refusals');
  assert.match(rule, /gmod/, 'a refusal by gmod is named');
  assert.match(rule, /hook/i, 'a refusal by its hooks is named');
  assert.match(rule, /sandbox/i, 'a refusal by the sandbox is named');
  assert.match(rule, /job needs/i, 'stopping is about what the job needs');
  assert.match(rule, /doesn't need[^.]*skip|skip[^.]*doesn't need/i, 'a refused tool the job does not need is skipped');
  assert.match(rule, /stop/i);
});

test('every hook runs gmod hook codex, on the events gmod needs', () => {
  const { hooks } = json('codex/hooks/hooks.json');
  const commands = Object.values(hooks).flat().flatMap(g => g.hooks);
  assert.ok(commands.length > 0);
  for (const h of commands) {
    assert.equal(h.type, 'command');
    assert.equal(h.command, 'gmod hook codex');
  }
  const matchers = (hooks.PreToolUse || []).map(g => new RegExp(`^(?:${g.matcher})$`));
  for (const tool of ['Bash', 'apply_patch']) assert.ok(matchers.some(r => r.test(tool)), `PreToolUse covers ${tool}`);
  for (const ev of ['SessionStart', 'SubagentStart', 'PostToolUse']) assert.ok(hooks[ev]?.length, `${ev} has a hook`);
});

test('the marketplace lists the plugin at ./codex', () => {
  const m = json('.agents/plugins/marketplace.json');
  const p = m.plugins.find(x => x.name === 'gmod');
  assert.ok(p);
  assert.equal(p.source.source, 'local');
  assert.equal(p.source.path, './codex');
  assert.ok(statSync(join(ROOT, p.source.path)).isDirectory());
});

test('the Codex skills name only served tools, and never the pane or slash commands', () => {
  const served = new Set(TOOLS.map(t => t.name));
  for (const s of SKILLS) {
    const path = join(CODEX, 'skills', s, 'SKILL.md');
    assert.ok(existsSync(path), path);
    const text = readFileSync(path, 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${s}\\ndescription: .+\\n---\\n`), `${s} frontmatter`);
    for (const [, name] of text.matchAll(/mcp__gmod__(\w+)/g)) assert.ok(served.has(name), `${s} names mcp__gmod__${name}`);
    for (const bad of [/pane/i, /\/gmod/, /allow-plan/]) assert.doesNotMatch(text, bad, `${s} mentions ${bad}`);
  }
});

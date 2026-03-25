import { existsSync } from 'node:fs';
import type { Config, HarnessDefinition } from './types';
import { expandHomePath } from './utils';

type BuiltInHarness = {
  id: string;
  label: string;
  rootPath: string;
  aliases?: string[];
};

const BUILT_IN_HARNESSES: BuiltInHarness[] = [
  { id: 'agents', label: 'Agents', rootPath: '~/.agents/skills', aliases: ['cline', 'warp', 'amp', 'kimi-cli', 'replit', 'universal'] },
  { id: 'antigravity', label: 'Antigravity', rootPath: '~/.gemini/antigravity/skills' },
  { id: 'claude-code', label: 'Claude Code', rootPath: '~/.claude/skills' },
  { id: 'codex', label: 'Codex', rootPath: '~/.codex/skills' },
  { id: 'cursor', label: 'Cursor', rootPath: '~/.cursor/skills' },
  { id: 'droid', label: 'Droid', rootPath: '~/.factory/skills' },
  { id: 'gemini-cli', label: 'Gemini CLI', rootPath: '~/.gemini/skills' },
  { id: 'github-copilot', label: 'GitHub Copilot', rootPath: '~/.copilot/skills' },
  { id: 'hermes', label: 'Hermes', rootPath: '~/.hermes/skills' },
  { id: 'skills', label: 'Skills Root', rootPath: '~/.skills' },
];

export function resolveHarnesses(homeDir: string, config: Config): HarnessDefinition[] {
  const builtIns: HarnessDefinition[] = BUILT_IN_HARNESSES.map((entry) => {
    const rootPath = expandHomePath(entry.rootPath, homeDir);
    return {
      id: entry.id,
      label: entry.label,
      rootPath,
      aliases: entry.aliases,
      kind: 'built-in',
      detected: existsSync(rootPath),
      enabled: existsSync(rootPath),
    };
  });

  const custom: HarnessDefinition[] = (config.harnesses.custom || []).map((entry) => {
    const rootPath = expandHomePath(entry.rootPath, homeDir);
    return {
      id: entry.id,
      label: entry.label || entry.id,
      rootPath,
      kind: 'custom',
      detected: existsSync(rootPath),
      enabled: entry.enabled !== false,
    };
  });

  const merged = new Map<string, HarnessDefinition>();
  for (const harness of [...builtIns, ...custom]) {
    merged.set(harness.id, harness);
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function filterHarnesses(harnesses: HarnessDefinition[], selectedIds: string[]): HarnessDefinition[] {
  if (selectedIds.length === 0) {
    return harnesses.filter((harness) => harness.enabled);
  }
  const selected = new Set(selectedIds);
  return harnesses.filter((harness) => selected.has(harness.id));
}

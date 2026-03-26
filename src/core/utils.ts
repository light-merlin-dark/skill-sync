import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { EntryInspection, JsonValue, RuntimeContext, SkillFrontmatter } from './types';

export function resolveHomeDir(explicitHome?: string): string {
  const envHome = process.env.SKILL_SYNC_HOME;
  if (explicitHome) {
    return resolve(explicitHome);
  }
  if (envHome) {
    return resolve(envHome);
  }
  return homedir();
}

export function buildRuntimeContext(options: { home?: string; json?: boolean }): RuntimeContext {
  const homeDir = resolveHomeDir(options.home);
  const stateDir = join(homeDir, '.skill-sync');
  return {
    homeDir,
    stateDir,
    configPath: join(stateDir, 'config.json'),
    statePath: join(stateDir, 'state.json'),
    json: Boolean(options.json),
  };
}

export function expandHomePath(input: string, homeDir: string): string {
  if (input === '~') {
    return homeDir;
  }
  if (input.startsWith('~/')) {
    return join(homeDir, input.slice(2));
  }
  return resolve(input);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJsonFile(path: string, value: JsonValue | Record<string, unknown>): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function timestampId(): string {
  return nowIso().replace(/[:.]/g, '-');
}

export function slugify(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-zA-Z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function parseSkillFrontmatterName(skillFilePath: string): string | undefined {
  const content = readFileSync(skillFilePath, 'utf8');
  return parseSkillFrontmatterContent(content).name;
}

export function parseSkillFrontmatterContent(content: string): SkillFrontmatter {
  const frontmatterLines = extractFrontmatterLines(content);
  if (!frontmatterLines) {
    return {
      hasFrontmatter: false,
      issues: ['missing YAML frontmatter block (`---` header)'],
    };
  }

  const frontmatter: SkillFrontmatter = {
    hasFrontmatter: true,
    issues: [],
  };
  for (let index = 0; index < frontmatterLines.length; index += 1) {
    const line = frontmatterLines[index]!;
    const nameMatch = line.match(/^name:\s*(.+)\s*$/);
    if (nameMatch) {
      frontmatter.name = stripYamlQuotes(nameMatch[1]!.trim());
      continue;
    }

    const descriptionMatch = line.match(/^description:\s*(.+)\s*$/);
    if (descriptionMatch) {
      frontmatter.description = stripYamlQuotes(descriptionMatch[1]!.trim());
      continue;
    }

    const scopeMatch = line.match(/^skill-sync-scope:\s*(.+)\s*$/);
    if (scopeMatch) {
      const value = stripYamlQuotes(scopeMatch[1]!.trim()).toLowerCase();
      if (value === 'global' || value === 'local-only') {
        frontmatter.skillSyncScope = value;
      }
      continue;
    }

    const installOnInlineMatch = line.match(/^skill-sync-install-on:\s*(.+)\s*$/);
    if (installOnInlineMatch) {
      const parsed = parseFrontmatterListValue(installOnInlineMatch[1]!);
      if (parsed.length > 0) {
        frontmatter.skillSyncInstallOn = parsed;
      }
      continue;
    }

    if (!/^skill-sync-install-on:\s*$/.test(line)) {
      continue;
    }

    const values: string[] = [];
    while (index + 1 < frontmatterLines.length) {
      const nextLine = frontmatterLines[index + 1]!;
      const itemMatch = nextLine.match(/^\s*-\s+(.+)\s*$/);
      if (!itemMatch) {
        break;
      }
      values.push(stripYamlQuotes(itemMatch[1]!.trim()));
      index += 1;
    }
    if (values.length > 0) {
      frontmatter.skillSyncInstallOn = values;
    }
  }

  if (!frontmatter.name) {
    frontmatter.issues.push('missing required `name:` in frontmatter');
  }

  return frontmatter;
}

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

export function listImmediateDirectories(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readdirSync(path)
    .map((name) => join(path, name))
    .filter((candidate) => {
      try {
        return lstatSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
}

export function inspectEntry(path: string): EntryInspection {
  if (!existsSync(path)) {
    return { exists: false, type: 'missing' };
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    const linkTarget = readFileSyncLink(path);
    let resolvedTarget: string | undefined;
    try {
      resolvedTarget = realpathSync(path);
    } catch {
      resolvedTarget = undefined;
    }
    return { exists: true, type: 'symlink', linkTarget, resolvedTarget };
  }
  if (stats.isDirectory()) {
    return { exists: true, type: 'directory' };
  }
  return { exists: true, type: 'file' };
}

function readFileSyncLink(path: string): string {
  return readlinkSync(path);
}

export function pathOwnsEntry(rootPath: string, entryPath: string): boolean {
  const normalizedRoot = normalizeComparablePath(rootPath);
  const normalizedEntry = normalizeComparablePath(entryPath);
  return normalizedEntry === normalizedRoot || normalizedEntry.startsWith(`${normalizedRoot}/`);
}

export function copyMaterialized(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  ensureDir(dirname(destination));
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false,
    preserveTimestamps: false,
  });
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function relativeLabel(path: string): string {
  return basename(path);
}

function extractFrontmatterLines(content: string): string[] | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return undefined;
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closingIndex === -1) {
    return undefined;
  }
  return lines.slice(1, closingIndex);
}

function stripYamlQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatterListValue(rawValue: string): string[] {
  const value = stripYamlQuotes(rawValue.trim());
  if (!value) {
    return [];
  }
  const inner = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
  return [...new Set(inner
    .split(',')
    .map((item) => stripYamlQuotes(item.trim()))
    .filter(Boolean))];
}

function normalizeComparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

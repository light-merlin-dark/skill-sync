import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { EntryInspection, JsonValue, RuntimeContext } from './types';

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
  if (!content.startsWith('---')) {
    return undefined;
  }
  const parts = content.split('\n---');
  if (parts.length < 2) {
    return undefined;
  }
  const match = parts[0].match(/^name:\s*(.+)\s*$/m);
  return match?.[1]?.trim();
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
  const normalizedRoot = resolve(rootPath);
  const normalizedEntry = resolve(entryPath);
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

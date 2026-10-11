/**
 * Guard for `tests/preload/test-temp-root.ts`: a test's temp files never outlive
 * its run, pass or fail, and a killed run's leftovers are reaped by the next.
 * Without the preload, fake homes from `tests/support.ts` (`skill-sync-home-*`)
 * accumulated in the flat user temp dir across runs.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const repoRoot = join(import.meta.dir, '../..');

describe('per-run test temp root', () => {
  test('tmpdir() is this run\'s own directory under test-runs/', () => {
    const runDir = tmpdir();
    expect(basename(dirname(runDir))).toBe('test-runs');
    expect(basename(runDir)).toMatch(new RegExp(`^${process.pid}-[A-Za-z0-9]+$`));
    expect(existsSync(runDir)).toBe(true);
  });

  test('a failing run removes its temp root and reaps dead runs, never live ones', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'temp-root-guard-'));
    const runs = join(sandbox, 'test-runs');
    const deadPid = spawnSync('true').pid!;
    const dead = join(runs, `${deadPid}-dead00`);
    const live = join(runs, `${process.pid}-live00`);
    mkdirSync(join(dead, 'leftover'), { recursive: true });
    mkdirSync(live, { recursive: true });
    const report = join(sandbox, 'report');

    const child = spawnSync('bun', ['test', './tests/fixtures/test-temp-root.fixture.ts'], {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: sandbox, TEST_TEMP_ROOT_REPORT: report },
      encoding: 'utf8',
    });

    expect(child.status).toBe(1);
    const leaked = readFileSync(report, 'utf8');
    expect(dirname(dirname(leaked))).toBe(runs);
    expect(existsSync(dirname(leaked))).toBe(false);
    expect(existsSync(dead)).toBe(false);
    expect(readdirSync(runs)).toEqual([basename(live)]);
  });
});

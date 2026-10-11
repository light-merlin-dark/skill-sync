/**
 * Every `bun test` run gets its own temp root, removed when the run's tests end.
 *
 * Every fake home from `tests/support.ts` is a `skill-sync-home-*` directory in
 * the user temp dir, and not every test removed its own, so they accumulated
 * across runs (over a hundred on one development machine). On macOS that temp
 * dir is one flat directory shared by every process; at tens of thousands of
 * entries every create and readdir in it slows down.
 *
 * Fixing test files one by one would leave the next one to regress, so the
 * runner owns it instead. Measured on Bun 1.4.2:
 *   - `exit` and `beforeExit` never fire under `bun test`, in any mode, so an
 *     exit hook removes nothing.
 *   - A preload's `afterAll` runs once at the end of a default run, and once per
 *     file under `--isolate` / `--parallel`, where each file also re-runs the
 *     preload in a fresh context with the original `TMPDIR`. Concurrent files
 *     share one pid.
 *
 * So, per preload context:
 *   1. `TMPDIR` points at a fresh `<tmp>/test-runs/<pid>-XXXXXX`, so every
 *      `tmpdir()` call — and every child process a test spawns — lands inside it.
 *   2. The preload's `afterAll` removes it, whether the tests passed or failed.
 *   3. A run killed by a timeout or signal never reaches `afterAll`; the next run
 *      removes any `test-runs/<pid>-*` whose pid is dead. A live pid's directory
 *      is never touched — including our own pid's siblings, which are concurrent
 *      files of this same run.
 *
 * `test-runs/` is deliberately repo-neutral: any repo using this convention may
 * reap another's dead runs, and none can reap a live one.
 * Guarded by `tests/unit/test-temp-root.test.ts`.
 */
import { afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_RUNS_DIR = 'test-runs';
const RUN_DIR = /^(\d+)-[A-Za-z0-9]+$/;

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM: alive, owned by someone else. Only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

const inheritedTmpdir = process.env.TMPDIR;
const base = tmpdir();
const runsRoot = join(base, TEST_RUNS_DIR);
mkdirSync(runsRoot, { recursive: true, mode: 0o700 });

for (const name of readdirSync(runsRoot)) {
  const match = RUN_DIR.exec(name);
  if (match && pidIsDead(Number(match[1]))) {
    rmSync(join(runsRoot, name), { recursive: true, force: true });
  }
}

const runDir = mkdtempSync(join(runsRoot, `${process.pid}-`));
process.env.TMPDIR = runDir;

afterAll(() => {
  if (inheritedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = inheritedTmpdir;
  rmSync(runDir, { recursive: true, force: true });
});

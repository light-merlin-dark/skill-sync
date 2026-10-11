// Run only by tests/test-temp-root.test.ts, as a child `bun test`. The name is
// outside Bun's test-file patterns so the suite never collects it directly.
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('leaves a fixture behind, then fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leaky-fixture-'));
  writeFileSync(join(dir, 'marker'), 'x');
  writeFileSync(process.env.TEST_TEMP_ROOT_REPORT!, dir);
  expect('cleanup runs on failure').toBe('the point of this fixture');
});

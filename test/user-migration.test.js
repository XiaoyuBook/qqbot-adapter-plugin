import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('offline identity/data migration preserves history, credentials, ownership and rollback boundaries', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('python3', ['test/user-migration.py'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 11 tests/);
});

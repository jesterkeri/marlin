import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicId } from '../src/db/repo.js';

test('deterministicId: stable for the same key (replay-safe), distinct across keys, UUID-shaped', () => {
  const a = deterministicId('submission:abc');
  const b = deterministicId('submission:abc');
  assert.equal(a, b); // same natural key → same id, so replay + child FKs stay consistent
  assert.notEqual(a, deterministicId('submission:xyz'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

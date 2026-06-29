import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockhashExpired } from '../src/faultInjection.js';

test('isBlockhashExpired: block height past lastValidBlockHeight (block height, not slot)', () => {
  assert.equal(isBlockhashExpired(151, 150), true);
  assert.equal(isBlockhashExpired(150, 150), false);
  assert.equal(isBlockhashExpired(10, 150), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSubmitNow, slotsUntilLeader } from '../src/ingest/leaderSchedule.js';

test('slotsUntilLeader + shouldSubmitNow leader-window logic', () => {
  assert.equal(slotsUntilLeader(100, 108), 8);
  assert.equal(slotsUntilLeader(100, 95), -5);
  assert.equal(shouldSubmitNow(100, 108, 8), true); // within lookahead
  assert.equal(shouldSubmitNow(100, 109, 8), false); // just outside
  assert.equal(shouldSubmitNow(100, 100, 8), true); // now
  assert.equal(shouldSubmitNow(100, 99, 8), false); // already passed
});

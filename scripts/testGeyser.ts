import 'dotenv/config';
import process from 'node:process';
import { GeyserIngestor } from '../src/ingest/geyser.js';

/**
 * Standalone gRPC connection test. Reads GEYSER_URL + GEYSER_TOKEN from .env and
 * tries to stream a few slots. Prints whether Yellowstone gRPC actually works on
 * your plan BEFORE you bother filling the rest of .env and running the batch.
 *
 *   npm run test:geyser
 */
const endpoint = process.env.GEYSER_URL?.trim();
const token = process.env.GEYSER_TOKEN?.trim();

if (!endpoint) {
  console.error('GEYSER_URL is not set in .env');
  process.exit(1);
}

let slots = 0;
let done = false;

const g = new GeyserIngestor({
  endpoint,
  token,
  handlers: {
    onChainHead: (h) => {
      slots++;
      console.log(`  slot ${h.slot}  (${h.status})`);
      if (slots >= 5) finish(true);
    },
  },
});

const timer = setTimeout(() => finish(false), 15_000);

function finish(ok: boolean): void {
  if (done) return;
  done = true;
  clearTimeout(timer);
  g.stop();
  if (ok) {
    console.log('\n  gRPC STREAMS WORK on this plan. Marlin is unblocked — fill the rest of .env and run `npm run run:batch`.');
    process.exit(0);
  } else {
    console.log('\n  No slots in 15s. Likely causes: gRPC gated on the Free plan (needs a plan/credits),');
    console.log('  a bad token, or the endpoint needs an https:// prefix (try GEYSER_URL=https://' + endpoint + ').');
    process.exit(1);
  }
}

console.log(`connecting to ${endpoint} ...`);
await g.start();

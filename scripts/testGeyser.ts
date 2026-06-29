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
const url: string = endpoint; // narrowed to string for use inside the closures below

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
  onFatal: (err) => finish(false, err.message), // auth/balance rejection — report it cleanly, don't loop
});

const timer = setTimeout(() => finish(false, 'no slots within 15s (silent gating, or wrong endpoint/token)'), 15_000);

function finish(ok: boolean, reason?: string): void {
  if (done) return;
  done = true;
  clearTimeout(timer);
  g.stop();
  if (ok) {
    console.log('\n  gRPC STREAMS WORK on this plan. Marlin is unblocked — fill the rest of .env and run `npm run run:batch`.');
    process.exit(0);
  } else {
    if (reason) console.log(`\n  gRPC not streaming: ${reason}`);
    console.log('  Most likely the account needs a funded balance (SolInfra PAYG minimum is $0.06) or the bounty credits applied.');
    console.log('  If you just funded/were credited, simply re-run. To try the bare endpoint form: GEYSER_URL=' + url.replace(/^https:\/\//, ''));
    process.exit(1);
  }
}

console.log(`connecting to ${endpoint} ...`);
await g.start();

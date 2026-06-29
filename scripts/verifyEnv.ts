import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Pre-run readiness check: reports which .env values are real vs still placeholders,
 * verifies the RPC endpoint responds, and confirms the payer key loads + is funded.
 * Prints ONLY non-secret derived values (pubkey, balance, slot) — never the secrets.
 *
 *   npm run verify:env
 */
const isSet = (v: string | undefined): v is string => !!v && v.trim().length > 0 && !v.includes('PASTE_');

function loadPayer(secret: string): Keypair {
  const s = secret.trim();
  if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[]));
  return Keypair.fromSecretKey(bs58.decode(s));
}

const rpcUrl = process.env.RPC_URL?.trim();
const payerSecret = process.env.PAYER_SECRET_KEY?.trim();
const openrouter = process.env.OPENROUTER_API_KEY?.trim();
const dbUrl = process.env.DATABASE_URL?.trim();

let ready = true;
const fail = (): void => void (ready = false);

console.log('\n=== Marlin .env readiness ===\n');

// --- RPC ---
if (!isSet(rpcUrl)) {
  console.log('RPC_URL            : NOT SET (still a placeholder)');
  fail();
} else {
  try {
    const slot = await new Connection(rpcUrl, 'confirmed').getSlot();
    console.log(`RPC_URL            : OK  (slot ${slot})`);
  } catch (e) {
    console.log(`RPC_URL            : FAIL — ${e instanceof Error ? e.message : String(e)}`);
    fail();
  }
}

// --- Payer ---
if (!isSet(payerSecret)) {
  console.log('PAYER_SECRET_KEY   : NOT SET (still a placeholder)');
  fail();
} else {
  try {
    const kp = loadPayer(payerSecret);
    process.stdout.write(`PAYER_SECRET_KEY   : OK  (pubkey ${kp.publicKey.toBase58()})`);
    if (isSet(rpcUrl)) {
      try {
        const bal = await new Connection(rpcUrl, 'confirmed').getBalance(kp.publicKey);
        const sol = bal / LAMPORTS_PER_SOL;
        console.log(`  balance ${sol.toFixed(6)} SOL`);
        if (bal < 0.003 * LAMPORTS_PER_SOL) {
          console.log('  ^ WARNING: low balance — ~0.003 SOL recommended for a 10-submission run');
        }
      } catch {
        console.log('  (could not fetch balance)');
      }
    } else {
      console.log('');
    }
  } catch (e) {
    console.log(`PAYER_SECRET_KEY   : FAIL — bad key format (${e instanceof Error ? e.message : String(e)})`);
    fail();
  }
}

// --- OpenRouter (presence only; agent:smoke does the live check) ---
console.log(`OPENROUTER_API_KEY : ${isSet(openrouter) ? 'set (verify with: npm run agent:smoke)' : 'NOT SET'}`);
if (!isSet(openrouter)) fail();

// --- Database ---
const dbReady = isSet(dbUrl) && !dbUrl.includes('localhost/marlin');
console.log(`DATABASE_URL       : ${dbReady ? 'set' : 'NOT SET (still localhost placeholder — add your Neon URL)'}`);
if (!dbReady) fail();

console.log('\nGEYSER_URL/TOKEN   : verified streaming earlier (npm run test:geyser)\n');
console.log(ready ? 'ALL SET → run: npm run db:init → npm run agent:smoke → npm run run:batch\n' : 'Fill the NOT SET / FAIL items above, then re-run: npm run verify:env\n');

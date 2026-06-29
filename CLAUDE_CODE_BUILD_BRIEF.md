# Marlin — Claude Code Build Brief

**Hand this whole file to Claude Code.** It's the authoritative build spec for the Superteam "Advanced Infrastructure Challenge – Build a Smart Transaction Stack" bounty ($5,000, Solana). Build to *every* requirement here; the judging maps directly to it.

---

## 0. Mission
Build a **smart transaction stack for Solana mainnet** that:
1. Streams live slot + leader data over **Yellowstone gRPC (Geyser)**.
2. Detects the **correct leader window** and submits **real Jito bundles** on **mainnet-beta**.
3. Calculates **dynamic tips from live data** (real recent Jito tip-account data + current network conditions). **No hardcoded tip values, ever.**
4. Tracks each transaction's **lifecycle** (submitted → processed → confirmed → finalized) with timestamps, slot numbers, and **latency deltas**, confirming landing **via stream subscriptions** (not RPC polling alone).
5. **Detects and classifies failures** (expired blockhash, fee/tip too low, compute exceeded, bundle failure) and **retries automatically** (including blockhash refresh on expiry).
6. Runs an **AI agent that owns ONE real operational decision**: **Autonomous Retry with Fault Injection** (see §6). The agent must *reason*, not run hardcoded if/else.

There must be a **clean separation between the AI layer and the core transaction stack.**

---

## 1. Hard Constraints (non-negotiable — these are scored)
- **Mainnet-beta only.** Jito bundles do not exist on devnet — real, explorer-verifiable bundles require mainnet. Use trivial self-transfers as payloads and a **hard tip cap** (`TIP_HARD_CAP_LAMPORTS`) to keep cost to cents.
- **No hardcoded tips.** Tips derive from live Jito tip-account data + congestion every time.
- **Stream-confirmed landing.** Use Geyser stream subscriptions to confirm commitment progression; RPC polling is fallback only.
- **Real failures.** Must demonstrate ≥2 real failure cases in the lifecycle log (blockhash expiry + fee/tip-too-low are the easiest; compute-exceeded optional).
- **AI is not a wrapper.** The agent must make a genuine, reasoned decision with visible reasoning. Sequential function calls without reasoning will be disqualified.
- **Clean layering.** `ai/` never touches signing/submission internals directly; it returns a decision object the core stack executes.

---

## 2. Deployment & Infrastructure
- **Compute:** a **VPS** (always-on; pm2 or systemd). Serverless (Vercel/Lambda) is forbidden for the engine — it can't hold a persistent gRPC stream. Pick a **region near your RPC/Yellowstone provider and the Jito block engine** to minimize propagation latency into the leader window (document this choice — it's a judged "infrastructure decision").
- **Database:** **Postgres running on the same VPS** (colocated → low write latency, one fewer dependency, no serverless connection limits). Async writes only — never block submission on persistence.
- **RPC + Geyser:** use the **SolInfra credits** the bounty provides (high-perf RPC + Yellowstone gRPC). Configure **primary + fallback** providers.
- **Dashboard (optional):** small read-only Express/static page served from the same VPS (or Vercel for just the frontend if desired).

---

## 3. Tech Stack
`TypeScript` (Node, ESM) · `@solana/web3.js` · `@triton-one/yellowstone-grpc` (Geyser client) · `jito-ts` (Block Engine bundles) · `pg` (local Postgres) · `openai` SDK → **OpenRouter** (the agent; OpenAI-compatible, cheaper) · `express` + `pino`.

---

## 4. Build Order — Vertical Slice First (protect this)
The full ambitious scope is real but risky in the time window. **Build the vertical slice end-to-end before any polish.** Nothing in Phase 2 starts until Phase 1 runs.

**Phase 1 — the slice (must finish):**
1. Geyser slot stream live (logs real slots, reconnects).
2. Tip oracle returning a live distribution from real data.
3. One real Jito bundle built (dynamic tip visible) + submitted on mainnet → captured signature.
4. Lifecycle persisted (submitted → processed → confirmed → finalized, slots + timestamps + deltas) via stream.
5. One forced **expired-blockhash** failure → classifier catches it → **AI retry decision** (refresh + new tip + timing) → autonomous resubmit.

**Phase 2 — after the slice works:** batch runner to ≥10 submissions (incl. the 2nd failure), tip-efficiency metrics, dashboard, failover, feedback loop. Dashboard polish is *last*.

## 5. Repository Structure
Files (the STAGE tags below match the Phase-1 order above):

```
marlin/
├── README.md                 # setup + the 3 required Q&As (see §9)
├── .env.example              # see §10
├── package.json / tsconfig.json
├── src/
│   ├── config.ts             # env, providers (primary+fallback), tip cap, region note
│   ├── logger.ts             # pino structured logging
│   ├── db/
│   │   ├── schema.sql         # submissions, lifecycle_events, tip_decisions, failures, agent_decisions
│   │   ├── init.ts            # apply schema
│   │   └── repo.ts            # async writes/reads
│   ├── ingest/
│   │   ├── geyser.ts          # [STAGE 1] Yellowstone subscribe: slots(processed/confirmed/finalized) + filtered tx; reconnect + backpressure
│   │   └── leaderSchedule.ts  # [STAGE 2] getLeaderSchedule + map upcoming Jito-leader windows
│   ├── tip/
│   │   └── tipOracle.ts       # [STAGE 3] live Jito tip-account data + getRecentPrioritizationFees + slot fullness -> tip distribution + congestion. NO hardcoded values
│   ├── exec/
│   │   ├── bundle.ts          # [STAGE 4] build user tx + tip-transfer to Jito tip account; jito-ts sendBundle
│   │   └── orchestrator.ts    # [STAGE 6] state machine: decide -> submit -> track -> classify -> retry; blockhash refresh
│   ├── track/
│   │   ├── lifecycle.ts       # [STAGE 5] stream-confirmed stage progression; timestamps, slots, latency deltas
│   │   └── failures.ts        # classify: ExpiredBlockhash | FeeTooLow | ComputeExceeded | BundleFailure
│   ├── ai/
│   │   └── agent.ts           # [STAGE 7] Autonomous Retry with Fault Injection — real LLM reasoning via OpenRouter (see §6)
│   ├── faultInjection.ts      # force a blockhash-expiry failure on demand
│   ├── obs/metrics.ts         # land rate, p50/p95 latencies, tip efficiency
│   └── index.ts               # wire-up + tiny read dashboard + a "run N submissions" script
└── scripts/
    └── runBatch.ts            # execute ≥10 submissions incl. ≥2 forced failures -> produces the lifecycle log
```

---

## 5. Core Stack Requirements (per the brief, point by point)
**Slot/leader monitoring (ingest/geyser.ts, leaderSchedule.ts):** subscribe to slot updates at all 3 commitments; maintain current slot + chain head. Implement **reconnection with exponential backoff** and **backpressure handling** (drop/queue policy on slow consumer).

> **Jito leader-window source (do this precisely):** `getLeaderSchedule` returns *all* Solana leaders, not which are reachable via the Jito block engine. Get the next **Jito-connected** leader from the **Jito Block Engine** itself — `jito-ts` `SearcherClient.getNextScheduledLeader()` returns the next Jito validator + its slot. Align that slot against the live slot stream to time submission. Use `getLeaderSchedule` only as supplementary context, not as the trigger.

**Dynamic tips (tip/tipOracle.ts) — name the exact source + fallback (this requirement is fragile if vague):**
- **Primary:** Jito tip-floor REST API → `GET https://bundles.jito.wtf/api/v1/bundles/tip_floor` (returns `landed_tips_25th/50th/75th/95th/99th_percentile` over a recent window). This is the canonical "real recent tip data."
- **Fallback (if the API is unreachable):** sample recent **inflows to the on-chain Jito tip accounts** via RPC over the last N slots to rebuild the distribution.
- Combine with `getRecentPrioritizationFees` + slot fullness → congestion score.
- Output `{floor, p50, p75, max, congestion}`. **Add a unit test / CI grep that fails if any constant tip literal exists in the tip path** — no hardcoded values, ever.

**Bundle construction (exec/bundle.ts):** build a bundle = user tx(s) + a **tip-transfer instruction to a real Jito tip account**; set CU limit/price, fresh **processed/confirmed** blockhash (never finalized — see §9 Q2); sign; `sendBundle` to the nearest Jito region.

**Lifecycle tracking (track/lifecycle.ts):** for every submission record stage transitions **from the Geyser stream**: `submitted, processed, confirmed, finalized`, each with **timestamp + slot number**, plus **latency deltas** between stages. Persist every event.

**Failure detection (track/failures.ts):** classify `ExpiredBlockhash`, `FeeTooLow`, `ComputeExceeded`, `BundleFailure`. Persist classification.

**Automatic retries (exec/orchestrator.ts):** on failure, retry automatically — **refresh blockhash on expiry**, recompute tip, resubmit, bounded by `MAX_RETRIES`. (For the AI-owned path, the *decision* of what to change comes from the agent — §6.)

---

## 6. AI Agent — "Autonomous Retry with Fault Injection" (the owned decision)
This is the single operational decision the agent owns. It must be **real reasoning via the LLM**, with **visible rationale**, cleanly separated from the core stack.

> **Deterministic-vs-AI boundary (resolve this cleanly):** the **classifier is deterministic** and enforces *mandatory safety actions* — an expired blockhash is **always** refreshed, a CU-exceeded tx is **always** re-budgeted. Those are not AI choices. The **AI owns the discretionary judgment**: the new **tip amount**, the **retry timing** (now / hold-one-window / escalate / abort), and the **reasoning**. Guardrails apply the mandatory safety actions and the caps regardless of model output. So the loop is: *classifier identifies the failure → mandatory safety applied → AI decides tip/timing/rationale within the envelope → orchestrator executes.* This satisfies "no hardcoded retry flow" (the discretionary decision is the AI's) without pretending safety-critical fixes are optional.

**Flow:**
1. `faultInjection.ts` deliberately submits a bundle with a **stale/expired blockhash** (forced failure).
2. The stack detects + classifies the failure (`ExpiredBlockhash`).
3. The failure context (classification, slot, current network conditions, tip distribution, recent land outcomes) is handed to **`ai/agent.ts`**.
4. The agent **reasons** (LLM call via OpenRouter, structured — OpenAI-style function/tool calling) about: *why* it failed, *what should change* before retrying — i.e. it decides **(a) refresh the blockhash, (b) the new tip amount given current congestion, and (c) whether to fire into the imminent window or hold**. Output:
   ```json
   {
     "diagnosis": "blockhash expired: submitted blockhash was N slots old vs 150-slot validity; ...",
     "actions": { "refresh_blockhash": true, "new_tip_lamports": 38000, "submit": "NOW | HOLD_ONE_WINDOW" },
     "confidence": 0.81,
     "rationale": "..."
   }
   ```
5. The orchestrator executes the agent's actions and resubmits **autonomously**. `new_tip_lamports` is **clamped** to `[oracle.floor, TIP_HARD_CAP_LAMPORTS]` in code (the AI chooses within a deterministic envelope; it can never exceed the cap or sit in the signing path).
6. Persist the full decision (inputs + output + rationale) to `agent_decisions` and surface it on the dashboard.

**Guardrails:** no hardcoded retry flow; the retry parameters come from the agent's reasoning. Bounded by `MAX_RETRIES` / `MAX_HOLD_WINDOWS`. All decisions auditable.

---

## 7. Lifecycle Log Deliverable (§3 of the bounty)
`scripts/runBatch.ts` must produce a log from **≥10 real mainnet bundle submissions**, including **≥2 failure cases**: (1) a forced **blockhash expiry**, and (2) a **deliberately sub-floor tip derived from the live floor at submit time** (e.g. `floor * 0.2`) — never a hardcoded low number, so even the *failure* case proves the tip is computed dynamically. Each entry:
- slot numbers (per stage)
- commitment progression
- timestamps (per stage) + latency deltas
- tip amount
- failure classification (if applicable)
- the bundle/tx **signature** (so judges can verify on a Solana explorer)

Export as JSON **and** a human-readable table. Spot-check a few signatures on Solscan/Solana Explorer before submitting — judges will.

---

## 8. Observability / Dashboard
Read view (from Postgres) showing: the lifecycle table over time, per-submission **agent decision + rationale**, **tip efficiency** (tip paid vs minimum landed tip that block), land rate, p50/p95 processed/confirmed/finalized latencies, stream uptime. This is what the demo video films.

**Dashboard design language — use Mako's design *style* (NOT its colors).** Source of truth: **the Mako Market repo** — Claude Code should pull it and read the real frontend components / design tokens / `brand-sheet.html` directly (the `Claude Cowork/Mako/mako-brand/` files are a static snapshot if the repo isn't handy). Adopt the structural style:
- Neo-brutalist / Swiss-editorial: **flat surfaces, 1px hard black borders, no shadows, no rounded corners**.
- **Heavy black (900) display type** with tight tracking; **uppercase, wide-tracked (0.2em) small labels** (the `brand-label` pattern).
- **Monospace for ALL data** — slots, signatures, tips, timestamps, latency deltas (the `brand-mono` pattern). Fits the infra/terminal feel.
- The **`[ bracket ]` motif** for tags/labels.
- Bordered buttons that **invert on hover**.
**Swap the color tokens** for Marlin's own palette — do **not** reuse Mako's `--color-mako-red`, `--color-signal` (yellow), or `--color-paper`. Keep the *typography, borders, spacing, and component patterns*; change only the colors.

---

## 9. README — the 3 required questions
Answer from **your own running data**, but here is the technically-correct framing to anchor each (back each with real numbers/observations from your runs):

**Q1 — delta between `processed_at` and `confirmed_at`:** it measures how fast the cluster reached **optimistic confirmation** (a supermajority of stake voting on the block) after the leader processed it. A **small, stable delta** = healthy network, fast vote propagation, low fork contention. A **large or growing delta** = congestion, fork/contention, or slow vote propagation — i.e. network stress at submission time. Cite your observed deltas under different conditions.

**Q2 — why never use `finalized` commitment for a blockhash on a time-sensitive tx:** a blockhash is only valid for **~150 slots (~60–90s)**. The `finalized` blockhash lags the chain tip by the rooting depth (**~32 slots**), so you start already having burned ~a third of the validity window — it ages out far sooner and your expiry risk spikes. Use a **`processed`/`confirmed`** (recent) blockhash to maximize the usable lifetime. Back it with an observed expiry you caused.

**Q3 — what happens if the Jito leader skips their slot:** the bundle is **not executed** — bundles are atomic and only land if the designated Jito leader **produces the block** for their slot. A skipped slot = no block = the bundle simply isn't included (no partial execution, no funds moved beyond nothing). Your stack must **detect non-landing via the stream** and **resubmit for the next Jito leader window with a fresh blockhash + recomputed tip**. Show a real instance from your logs if you catch one.

---

## 10. Environment (.env.example)
```
RPC_URL= / RPC_FALLBACK_URL=        # SolInfra high-perf RPC
GEYSER_URL= / GEYSER_TOKEN=         # SolInfra Yellowstone gRPC
JITO_BLOCK_ENGINE_URL=              # region nearest target leader
PAYER_SECRET_KEY=                   # funded mainnet key (small balance)
DATABASE_URL=postgres://localhost/marlin   # local Postgres on the VPS
OPENROUTER_API_KEY=                 # agent LLM via OpenRouter (OpenAI-compatible)
OPENROUTER_MODEL=                   # cheap-but-capable slug
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
LEADER_LOOKAHEAD_SLOTS=8
MAX_HOLD_WINDOWS=2
MAX_RETRIES=3
TIP_HARD_CAP_LAMPORTS=200000        # ~0.0002 SOL ceiling — keep costs tiny
```

---

## 11. Acceptance Criteria (maps to judging)
- [ ] **Works:** functional stack; real lifecycle logs; ≥1 successful + ≥2 failed submissions demonstrated on mainnet, explorer-verifiable.
- [ ] **Depth:** correct slot streaming with reconnection + backpressure; real Jito bundles; dynamic tip from live data (no hardcoded); correct commitment usage; clean AI/core separation.
- [ ] **AI:** agent makes a meaningful, *reasoned* decision (fault-injection retry); reasoning visible/persisted; not sequential automation.
- [ ] **Explanation:** the public **Architecture document** (host `Architecture.md` separately — Notion/HackMD/GitHub Pages) + README depth + the 3 answers from real observations.
- [ ] **Deliverables:** open-source repo + clear setup + lifecycle log (≥10, ≥2 failures) + 3-min demo video.

---

## 12. Build to the architecture doc
The companion `Architecture.md` is the system design of record (components, data flow, failure handling, AI responsibilities, diagrams). Build the code to match it; if you diverge, update the doc so they stay consistent — judges read both.
```

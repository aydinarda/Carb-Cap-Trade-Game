/**
 * Full-session load test — Carbon Cap & Trade (socket.io backend)
 *
 * Classroom-paced, end-to-end load, run against the DEPLOYED backend so you can join
 * in a browser and feel the latency while 100 simulated players hammer the server.
 *
 * One session per cap mechanism, played in sequence, because host:addBots is lobby-only:
 *   1. grandfathering — 1 host + 100 players, a few years played to completion
 *   2. benchmarking   — same + 6 bots (they trade the order book; no auction to bid into)
 *   3. auctioning     — same + 6 bots (2 marketMaker / 2 compliance / 1 noise / 1 speculator)
 *
 * Set MODES to play only some of them — `MODES=auctioning` goes straight there instead of
 * sitting through two full games first.
 *
 * Each session: create → 100 players join → (bots) → a JOIN grace window (join in the
 * browser now!) → per year: cap stage (auction bids, where the mode has an auction) →
 * trade window (players place bids/asks + abate at a relaxed cadence) → settle →
 * advance → endGame.
 *
 * The players get session:snapshot pushed (no polling); we drive their ACTIONS and
 * measure the ack round-trip. Expected 4xx (no-shorting, wrong-phase races) are counted
 * separately, not as failures.
 *
 * NOTE ON PRICES. This is a *load* test, but its price path gets read as a finding, so the
 * synthetic players must behave like the ones the simulator models: abate to the sector's
 * cost-minimising point (capped by `maxAbatement`), value a tonne at `min(penaltyRate,
 * MAC(r*))` — the same ceiling every bot uses — and quote with SYMMETRIC noise around it.
 *
 * An earlier version quoted `lastPrice × U(1.0, 1.1)` to buy and `× U(0.9, 1.0)` to sell,
 * reading `lastPrice` back from its own prints — a feedback loop with ±5% drift that
 * compounded to €400 (short class) or €3 (long class) and had nothing to do with the game's
 * own parameters. Do not reintroduce asymmetric drift here.
 *
 * KNOWN DIVERGENCES from sim/sweeps/price-calibration.ipynb, which uses a different class:
 *   - every player here is identical; the simulator has four behaviour archetypes, one of
 *     which (`passive`, 25% of the class) never abates. This class therefore cuts MORE, so
 *     it clears at a lower price than the notebook predicts.
 *   - 6 bots here vs 22 there, and 3 years vs 10 by default.
 * Set YEARS_PER_MODE=10 and the calibration env vars below to compare like for like.
 *
 *   node scripts/load-full-session.mjs
 *   MODES=auctioning YEARS_PER_MODE=10 node scripts/load-full-session.mjs
 *   BASE_URL=https://carb-cap-trade-api.onrender.com HOST_KEY=admin123 \
 *     N_PLAYERS=100 YEARS_PER_MODE=3 ROUND_WINDOW=25 node scripts/load-full-session.mjs
 */
import { io } from 'socket.io-client'

const BASE = (process.env.BASE_URL || 'https://carb-cap-trade-api.onrender.com').replace(/\/$/, '')
const HOST_KEY = process.env.HOST_KEY || 'admin123'
const FRONTEND_URL = process.env.FRONTEND_URL || '' // optional, only for the "join here" log
const N_PLAYERS = Number(process.env.N_PLAYERS || 100)
const YEARS_PER_MODE = Number(process.env.YEARS_PER_MODE || 3)
const ROUND_WINDOW = Number(process.env.ROUND_WINDOW || 25) // trade window seconds
const CAP_WINDOW = Number(process.env.CAP_WINDOW || 10) // auction cap-stage window seconds
const REVIEW_GAP = Number(process.env.REVIEW_GAP || 3) // seconds between years
// Applied to EVERY session — each mode is a fresh room with a fresh code, so you get the
// same window to join each one. Long enough to actually get in: GitHub Actions streams its
// logs with a few seconds of lag, and joining is lobby-only — miss the window and the
// server rejects you with a wrong-phase error once year 1 has started.
const JOIN_GRACE = Number(process.env.JOIN_GRACE || 90)

// Calibration knobs, applied per session via host:updateSettings. Unset = shipped default,
// so the workflow keeps testing the shipped game unless you deliberately ask otherwise.
// These are the numbers sim/sweeps/price-calibration.ipynb searches over — without them the
// load test cannot exercise a calibration at all, only whatever defaults.ts happens to hold.
const PENALTY_RATE = process.env.PENALTY_RATE ? Number(process.env.PENALTY_RATE) : null
const AUCTION_CAP_RATIO = process.env.AUCTION_CAP_RATIO ? Number(process.env.AUCTION_CAP_RATIO) : null
const CAP_REDUCTION = process.env.CAP_REDUCTION_FACTOR ? Number(process.env.CAP_REDUCTION_FACTOR) : null
const FREE_CREDIT_RATIO = process.env.FREE_CREDIT_RATIO ? Number(process.env.FREE_CREDIT_RATIO) : null
const BENCHMARK_STRINGENCY = process.env.BENCHMARK_STRINGENCY
  ? Number(process.env.BENCHMARK_STRINGENCY)
  : null
// Sector averages, mirroring shared/constants.ts — the benchmark table is what
// `benchmarkFor` reads; `allocation.benchmarkStringency` is dead config and does nothing.
const SECTOR_AVERAGE = {
  'Power & Utilities': 1000,
  'Heavy Materials': 800,
  'Manufacturing & Chemicals': 525,
  Transport: 300,
}

/**
 * Which cap mechanisms to play, in order. `all` (default) plays the three sequentially.
 * Name one — or a comma-separated subset — to skip straight to it: testing auctioning meant
 * sitting through two full games first, which at 90 s join grace and 3 years each is most of
 * a quarter of an hour before the mode you came for even starts.
 */
const ALL_MODES = ['grandfathering', 'benchmarking', 'auctioning']
const MODES = (() => {
  const raw = (process.env.MODES || 'all').trim().toLowerCase()
  if (!raw || raw === 'all') return ALL_MODES
  const picked = raw.split(',').map((m) => m.trim()).filter(Boolean)
  const unknown = picked.filter((m) => !ALL_MODES.includes(m))
  if (unknown.length) {
    throw new Error(`unknown mode(s): ${unknown.join(', ')} — pick from ${ALL_MODES.join(', ')} or "all"`)
  }
  // Keep the canonical order however they were listed, so logs stay comparable.
  return ALL_MODES.filter((m) => picked.includes(m))
})()

/**
 * Bots per mode. Grandfathering ships without them because that is how the broadcast-load
 * failure was originally reproduced; override with BOTS=on/off to make the three comparable.
 */
/**
 * Market-maker target inventory, ESCALATING year by year.
 *
 * A maker's auction bid is the gap between its target and what it already holds, so a fixed
 * target is filled once and then bid at zero forever: measured over six years it took 18% of
 * the pool in year one and 0-2% in every year after, leaving the compliance bots to take
 * 63% -> 98% of it and the sell side of the book to thin out.
 *
 * Growing the target each round keeps a gap for the maker to bid into, so it stays a
 * participant instead of retiring after round one. `MM_INV_START` is the year-one share and
 * `MM_INV_STEP` the increase per year; 0 disables the escalation entirely.
 */
const MM_INV_START = process.env.MM_INV_START ? Number(process.env.MM_INV_START) : 0.18
const MM_INV_STEP = process.env.MM_INV_STEP ? Number(process.env.MM_INV_STEP) : 0.03

const BOTS_OVERRIDE = process.env.BOTS ? process.env.BOTS.trim().toLowerCase() : null
const withBotsFor = (mode) =>
  BOTS_OVERRIDE ? BOTS_OVERRIDE === 'on' || BOTS_OVERRIDE === 'true' : mode !== 'grandfathering'

const INDUSTRIES = [
  'Power & Utilities',
  'Heavy Materials',
  'Manufacturing & Chemicals',
  'Transport',
]
/**
 * The calibration class, copied from `sim/sweeps/calibrate.ts` so the load test and every
 * price target are measured on the same population.
 *
 * It used to be six bots, on a measurement that going 0 -> 5 dropped one-sided ticks from
 * 5.2% to 1.0% while 5 -> 25 bought almost nothing more. That measurement had 100 simulated
 * PLAYERS trading alongside the bots. With bots carrying the book on their own — a lightly
 * attended room — six is not enough: measured on a bots-only auctioning game, year one
 * printed 0 trades at six bots and 15 at twenty-two.
 */
const BOT_PLAN = [
  ['compliance', 9],
  ['marketMaker', 4],
  ['noise', 6],
  ['speculator', 3],
]

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (a, b) => a + Math.random() * (b - a)
const round1 = (n) => Math.round(n * 10) / 10
const round3 = (n) => Math.round(n * 1000) / 1000
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const connect = (auth) =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], auth, reconnection: false, timeout: 20000 })
    s.once('connect', () => resolve(s))
    s.once('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)))
  })

// ── metrics ──────────────────────────────────────────────────────────────────
const M = {
  actionLatency: [], // ack RTT ms for player actions
  accepted: 0,
  rejected4xx: 0, // expected (no-shorting, wrong phase) — not a failure
  errors: 0, // unexpected / 5xx / timeouts
  errorSamples: [], // first few, so a threshold failure names its own cause
  connectFail: 0,
  snapshots: 0,
}
/**
 * Refusals this harness EXPECTS the engine to make, by `GameError` code.
 *
 * These are the engine working, not failing: a player asked for something the rules forbid,
 * usually because 50 simulated players race each other inside one trade window. Anything
 * NOT listed here counts against the error threshold.
 */
const EXPECTED_CODES = new Set([
  'NO_SHORTING',    // selling more than you hold
  'ABATE_DOWN',     // retrofits are permanent; a target below what is built is refused
  'BAD_ABATE',      // a malformed fraction
  'WRONG_PHASE',    // the year moved on between deciding and sending
  'NO_ORDER',       // cancelling an order that already filled
  'BAD_ORDER',      // size or price outside the allowed range
])

function pct(arr, p) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))])
}

/** Emit with ack + timeout; records latency; returns the ack payload or throws. */
function emit(sock, event, payload, { measure = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    const done = (res) => {
      if (settled) return
      settled = true
      resolve(res)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 20000)
    sock.emit(event, payload, (res) => {
      clearTimeout(timer)
      if (measure) M.actionLatency.push(Date.now() - t0)
      done(res || { ok: false, error: 'no-ack' })
    })
  })
}

// ── a simulated player ───────────────────────────────────────────────────────
/**
 * Marginal abatement cost of the next tonne at cut fraction `f`, from the sector MAC spec
 * the player snapshot already carries. Mirrors `specMarginal` in shared/engine — inlined
 * because this is a plain .mjs script and cannot import the TypeScript engine.
 */
function marginalCost(f, spec) {
  if (!spec) return null
  const p = spec.params ?? spec
  switch (spec.model ?? 'linear') {
    case 'power': return p.a + p.b * Math.pow(f, p.n)
    case 'exponential': return p.a * Math.exp(p.k * f)
    default: return p.a + p.b * f
  }
}

/**
 * Cost-minimising cut fraction: where marginal cost meets the price. Linear form inverted.
 * `maxFraction` is the plant's physical ceiling — a company cannot switch itself off.
 */
function optimalAbatement(price, spec, maxFraction = 1) {
  if (!spec) return 0
  const p = spec.params ?? spec
  let r
  switch (spec.model ?? 'linear') {
    case 'power': r = p.b > 0 ? Math.pow(Math.max(0, (price - p.a) / p.b), 1 / p.n) : 0; break
    case 'exponential': r = p.k > 0 && p.a > 0 ? Math.log(Math.max(1e-9, price / p.a)) / p.k : 0; break
    default: r = p.b > 0 ? (price - p.a) / p.b : 0
  }
  return clamp(r, 0, clamp(maxFraction, 0, 1))
}

class Player {
  constructor(sock, id, penaltyRate, openingFraction = 0.25) {
    this.sock = sock
    this.id = id
    this.snap = null
    this.penaltyRate = penaltyRate
    this.openingFraction = openingFraction
    sock.on('session:snapshot', (s) => {
      this.snap = s
      M.snapshots++
    })
  }

  /**
   * What this company thinks a tonne is worth: its own cost of cutting it, capped at the
   * ceiling every agent in the game observes.
   *
   * MUST MATCH `priceCeiling` in server/bots/helpers.ts. Economically the fine is NOT a
   * ceiling — paying it does not discharge the obligation, the tonne carries forward as
   * make-good debt (shared/engine/settlement.ts) — and the engine can price that carry via
   * `bots.fixes.ceilingIncludesCarry`. But that flag ships OFF, so every bot clamps at
   * `penaltyRate`, and a harness player valuing tonnes at `penaltyRate + reference` would
   * outbid all of them and print above the fine. The load test would then be measuring a
   * class the simulator never modelled.
   *
   * If that flag is ever turned on, this has to move with it.
   */
  fairValue() {
    const s = this.snap
    const ref = this.refPrice()
    const spec = s?.abatement
    const rStar = optimalAbatement(ref, spec, s?.maxAbatement ?? 1)
    const mc = marginalCost(rStar, spec)
    const ceiling = this.penaltyRate
    if (mc === null) return Math.min(ceiling, ref)
    return Math.min(ceiling, mc)
  }

  /** Auctioning cap stage: submit one sealed bid at what a tonne is worth to this company. */
  async submitAuctionBid() {
    const y = this.snap?.you
    const expected = y?.expectedEmission ?? 100
    const fair = this.fairValue()
    const res = await emit(
      this.sock,
      'player:submitBid',
      { qty: round1(expected * rand(0.6, 1.0)), price: round1(fair * rand(0.92, 1.08)) },
      { measure: true },
    )
    this.tally(res)
  }

  /**
   * Trade window: cut what is worth cutting, then cover the residual (bid) or sell the
   * surplus (ask).
   *
   * The quote is centred on `fairValue()` with SYMMETRIC noise. It used to be
   * `ref × U(1.0, 1.1)` to buy and `ref × U(0.9, 1.0)` to sell, with `ref` read back from
   * the lastPrice these very orders set — a closed feedback loop with ±5% drift and no
   * anchor, which compounded geometrically over a trade window and drove the price to
   * either €400 or €3 depending only on which side happened to dominate. The noise was
   * never the problem; the drift was.
   */
  async tradeTick() {
    const s = this.snap
    if (!s || s.phase !== 'trade') return
    const y = s.you
    const held = y?.creditsHeld ?? 0
    const expected = y?.expectedEmission ?? 0
    const fair = this.fairValue()

    // Abate to the cost-minimising point first — that is what makes the residual, and
    // what makes the penalty bite as a ceiling rather than a formality.
    //
    // `abatementLifetimeCap`, not `maxAbatement`: the latter is not a field on the snapshot,
    // so it read `undefined` and the cap silently fell back to 1. The engine clamps to the
    // real cap anyway, so nothing broke loudly — the harness just sized every residual
    // against a cut its player was never allowed to make.
    const installed = y?.abatementCommitted ?? 0
    const rStar = optimalAbatement(this.refPrice(), s.abatement, s.abatementLifetimeCap ?? 1)
    // Capacity is PERMANENT: `setAbatement` refuses a target below what is already built.
    // The price moves within a year, so a naive "abate to r* every tick" issues a doomed
    // call every time r* dips — 65 of them in a 7-year run, all counted as server errors.
    // Ask only when there is something to add.
    if (rStar > installed + 0.01 && Math.random() < 0.3) {
      this.tally(await emit(this.sock, 'player:abate', { fraction: round1(rStar) }))
    }

    // Against what is in force THIS year, not against the target: capacity bought now comes
    // online next year, so planning this year's cover around r* buys too little.
    const inForce = y?.abatementInForce ?? 0
    const need = expected * (1 - inForce) - held // >0 short, <0 surplus
    if (need > 1) {
      const qty = round1(clamp(need * rand(0.3, 1), 1, need))
      this.tally(await emit(this.sock, 'player:placeOrder',
        { side: 'buy', qty, price: round1(fair * rand(0.95, 1.05)) }, { measure: true }))
    } else if (need < -1) {
      // Stay well under holdings so the no-shorting guard rarely trips.
      const qty = round1(clamp(-need * rand(0.3, 1), 1, held * 0.8))
      if (qty >= 1) this.tally(await emit(this.sock, 'player:placeOrder',
        { side: 'sell', qty, price: round1(fair * rand(0.95, 1.05)) }, { measure: true }))
    }
  }

  refPrice() {
    const s = this.snap
    const mv = s?.market
    // Cold start matches the engine's own `openingReference`, which is
    // `penaltyRate × openingReferenceFraction` — read, never assumed. It was hardcoded to
    // half the fine; the shipped fraction is now 0.25, so the harness was anchoring its
    // first year at €50 against an engine anchoring at €25. That is exactly the harness-vs-
    // engine price drift this fallback exists to prevent.
    return mv?.lastPrice ?? mv?.vwap ?? s?.prevMarketPrice ?? s?.auctionPrice
      ?? this.penaltyRate * this.openingFraction
  }

  /**
   * Expected refusals vs real faults.
   *
   * Keyed on the error CODE the server now sends. The prose regex below is the fallback for
   * a server that predates it — and is why this misfired in the first place: `ABATE_DOWN`'s
   * message ("Retrofits are permanent — you can add more, but not take it back") matches
   * none of those words, so every one of them was tallied as an unexpected error.
   */
  tally(res) {
    if (!res) return
    if (res.ok) { M.accepted++; return }
    if (res.code && EXPECTED_CODES.has(res.code)) { M.rejected4xx++; return }
    if (!res.code && /no shorting|at most|phase|not allowed|WRONG|INSUFFICIENT|permanent/i.test(res.error || '')) {
      M.rejected4xx++
      return
    }
    M.errors++
    if (M.errorSamples.length < 8) M.errorSamples.push(`${res.code ?? '—'}: ${res.error}`)
  }
}

// ── one full session for a given cap mode ────────────────────────────────────
async function runSession(capMode, { withBots, joinGrace }) {
  console.log(`\n══════════ ${capMode.toUpperCase()} ══════════`)
  const host = await connect({ role: 'host' })
  // The players value a tonne against the fine, so they need the rate in force. Only the
  // host snapshot carries it.
  let hostSnap = null
  host.on('session:snapshot', (s) => { if (s.role === 'host') hostSnap = s })
  const created = await emit(host, 'host:createSession', { hostKey: HOST_KEY, capMode })
  if (!created.ok) throw new Error(`createSession failed: ${created.error} (check HOST_KEY)`)
  const roomCode = created.roomCode
  await sleep(200)

  // Apply the calibration before anyone joins. updateSettings is lobby-only, and
  // freeCreditRatio has to be in place before startYear computes the free credit limit.
  const settings = {}
  if (PENALTY_RATE !== null) settings.penaltyRate = PENALTY_RATE
  if (AUCTION_CAP_RATIO !== null) settings.auctionCapRatio = AUCTION_CAP_RATIO
  if (CAP_REDUCTION !== null) settings.capReductionFactor = CAP_REDUCTION
  if (BENCHMARK_STRINGENCY !== null) {
    settings.benchmark = Object.fromEntries(
      Object.entries(SECTOR_AVERAGE).map(([k, v]) => [k, Math.round(v * BENCHMARK_STRINGENCY * 10) / 10]),
    )
  }
  if (Object.keys(settings).length) {
    const r = await emit(host, 'host:updateSettings', settings)
    if (!r.ok) throw new Error(`updateSettings failed: ${r.error}`)
    console.log(`settings applied: ${JSON.stringify(settings)}`)
  }
  if (FREE_CREDIT_RATIO !== null) {
    console.log(`  ⚠ FREE_CREDIT_RATIO=${FREE_CREDIT_RATIO} ignored — host:updateSettings has no`)
    console.log('    field for it; set allocation.freeCreditRatio in defaults.ts to test it.')
  }

  await sleep(150)
  const penaltyRate = hostSnap?.config?.penaltyRate ?? 100
  // Read from the host snapshot rather than assumed: it is a calibration knob and has
  // already moved from 0.5 to 0.25.
  const openingFraction = hostSnap?.config?.openingReferenceFraction ?? 0.25
  console.log(`opening anchor: ${openingFraction} → year-1 reference ${round1(penaltyRate * openingFraction)}`)
  console.log(
    `mm target inventory: ${MM_INV_START} +${MM_INV_STEP}/yr` +
      (MM_INV_STEP === 0 ? ' (flat)' : ` → ${round3(MM_INV_START + MM_INV_STEP * (YEARS_PER_MODE - 1))} by the last year`),
  )
  console.log(`penalty rate in force: ${penaltyRate}` +
    `  ·  capReduction ${hostSnap?.config?.capReductionFactor ?? '?'}` +
    `  ·  auctionCapRatio ${hostSnap?.config?.auctionCapRatio ?? '?'}`)

  // Join players (batched to avoid a connection storm).
  const players = []
  for (let i = 0; i < N_PLAYERS; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, N_PLAYERS - i) }, async (_, k) => {
        const n = i + k
        try {
          const sock = await connect({})
          const j = await emit(sock, 'player:join', {
            roomCode,
            name: `L${String(n + 1).padStart(3, '0')}`,
            industry: INDUSTRIES[n % INDUSTRIES.length],
          })
          if (!j.ok) { M.errors++; sock.close(); return null }
          return new Player(sock, j.playerId, penaltyRate, openingFraction)
        } catch { M.connectFail++; return null }
      }),
    )
    players.push(...batch.filter(Boolean))
  }
  console.log(`joined ${players.length}/${N_PLAYERS} players`)

  if (withBots) {
    for (const [botType, count] of BOT_PLAN) {
      const r = await emit(host, 'host:addBots', { botType, count })
      if (!r.ok) M.errors++
    }
    console.log(`added ${BOT_PLAN.reduce((n, [, c]) => n + c, 0)} bots (` +
      BOT_PLAN.map(([t, c]) => `${c} ${t}`).join(' / ') + ')')
  }

  // ── JOIN WINDOW: hop in as a player now ──
  const joinHint = FRONTEND_URL ? `${FRONTEND_URL}  →  ` : ''
  console.log(`\n  ┌─────────────────────────────────────────────┐`)
  console.log(`  │  JOIN NOW → room code:  ${roomCode.padEnd(20)}│`)
  console.log(`  └─────────────────────────────────────────────┘`)
  console.log(`  ${joinHint}enter the code above (${joinGrace}s grace)\n`)
  await sleep(joinGrace * 1000)

  // ── play YEARS_PER_MODE years ──
  for (let year = 1; year <= YEARS_PER_MODE; year++) {
    // Set BEFORE the year opens: `updateSettings` is lobby/yearSummary only, and this is
    // the last moment in the loop where the session is still in one of those phases.
    const invFrac = round3(MM_INV_START + MM_INV_STEP * (year - 1))
    if (MM_INV_STEP !== 0 || year === 1) {
      const u = await emit(host, 'host:updateSettings', { marketMakerInvFrac: invFrac })
      if (!u.ok) {
        M.errors++
        console.log(`  mm invFrac ${invFrac} rejected: ${u.error}`)
      } else {
        // Verify it LANDED. An older backend accepted unknown keys and acked ok, so the
        // setting vanished and the run looked exactly like a knob that does not matter.
        // Confirm against the snapshot rather than trusting the ack.
        await sleep(250)
        const inForce = hostSnap?.config?.marketMakerInvFrac
        if (inForce === undefined) {
          console.log(
            `  ⚠ backend does not expose marketMakerInvFrac — this build predates it, ` +
              `so the MM escalation is NOT running. Redeploy before reading this run.`,
          )
        } else if (Math.abs(inForce - invFrac) > 1e-6) {
          console.log(`  ⚠ mm invFrac asked ${invFrac}, in force ${inForce}`)
        }
      }
    }

    const r = await emit(host, year === 1 ? 'host:startYear' : 'host:advanceYear', {})
    if (!r.ok) { M.errors++; console.log(`  year ${year} start failed: ${r.error}`); break }

    if (capMode === 'auctioning') {
      // Cap stage: players (and the server-driven bots) submit sealed auction bids.
      await Promise.all(players.map((p) => p.submitAuctionBid()))
      await sleep(CAP_WINDOW * 1000)
    }
    await emit(host, 'host:closeCapStage', {})
    await emit(host, 'host:openTrade', {})

    // Trade window: each player trades on its own relaxed cadence.
    let open = true
    const loops = players.map(async (p) => {
      while (open) {
        await p.tradeTick()
        await sleep(rand(3000, 9000)) // human-paced refresh/act
      }
    })
    await sleep(ROUND_WINDOW * 1000)
    open = false
    await Promise.allSettled(loops)

    await emit(host, 'host:closeTrade', {})
    const lb = players[0]?.snap?.leaderboard
    // Print the discovered price: this harness's price path is read as a result, so a
    // runaway must be visible in the log rather than only in a browser.
    const mv = hostSnap?.market
    const price = mv?.vwap ?? mv?.lastPrice
    const priceStr = price != null
      ? ` | vwap ${price} (min ${mv.trades?.length ? Math.min(...mv.trades.map((t) => t.price)) : '—'}` +
        ` max ${mv.trades?.length ? Math.max(...mv.trades.map((t) => t.price)) : '—'})`
      : ' | no trades'
    console.log(`  year ${year}/${YEARS_PER_MODE} settled` + priceStr +
      (lb ? ` | leader ${lb[0]?.name} (${lb[0]?.normalizedScore})` : ''))
    if (year < YEARS_PER_MODE) await sleep(REVIEW_GAP * 1000)
  }

  await emit(host, 'host:endGame', {})
  for (const p of players) p.sock.close()
  host.close()
  await sleep(1000) // let sockets drain
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Load test → ${BASE}  (${N_PLAYERS} players, ${YEARS_PER_MODE} yrs/mode)`)
  console.log(`modes: ${MODES.join(' → ')}`)
  // Wake the (possibly sleeping) Render instance first.
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) break
    } catch { /* retry */ }
    if (i === 9) throw new Error('backend /healthz never responded')
    await sleep(5000)
  }

  for (const mode of MODES) {
    await runSession(mode, { withBots: withBotsFor(mode), joinGrace: JOIN_GRACE })
  }

  // ── summary + thresholds ──
  const p50 = pct(M.actionLatency, 50)
  const p95 = pct(M.actionLatency, 95)
  console.log(`\n════════ SUMMARY ════════`)
  console.log(`actions: ${M.accepted} accepted, ${M.rejected4xx} expected-4xx, ${M.errors} errors`)
  console.log(`action latency: p50=${p50}ms  p95=${p95}ms  (${M.actionLatency.length} samples)`)
  console.log(`snapshots received: ${M.snapshots}  |  connect failures: ${M.connectFail}`)

  const fails = []
  if (p95 > 8000) fails.push(`p95 action latency ${p95}ms > 8000ms`)
  if (M.errors > 50) fails.push(`${M.errors} unexpected errors > 50`)
  if (M.errorSamples.length) {
    console.log(`first errors:\n  ${M.errorSamples.join('\n  ')}`)
  }
  if (M.connectFail > N_PLAYERS * 0.05) fails.push(`${M.connectFail} connect failures > 5%`)
  if (M.accepted === 0) fails.push('no actions were accepted (backend/host key wrong?)')

  if (fails.length) {
    console.log(`\n❌ THRESHOLDS FAILED:\n  - ${fails.join('\n  - ')}`)
    process.exit(1)
  }
  console.log(`\n✅ ALL THRESHOLDS PASSED`)
  process.exit(0)
}

main().catch((e) => {
  console.error(`\n💥 ${e.message}`)
  process.exit(1)
})

/**
 * Full-session load test — Carbon Cap & Trade (socket.io backend)
 *
 * Classroom-paced, end-to-end load, run against the DEPLOYED backend so you can join
 * in a browser and feel the latency while 100 simulated players hammer the server.
 *
 * Three sequential sessions (one per cap mechanism), because host:addBots is lobby-only:
 *   1. grandfathering — 1 host + 100 players, a few years played to completion
 *   2. benchmarking   — same + 6 bots (they trade the order book; no auction to bid into)
 *   3. auctioning     — same + 6 bots (2 marketMaker / 2 compliance / 1 noise / 1 speculator)
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
 * synthetic players have to stay economically plausible: they abate to their sector's
 * cost-minimising point and value a tonne at `min(penaltyRate, marginalCost(r*))`, the same
 * valuation the engine's bots and the headless sim's students use. Quote noise must stay
 * SYMMETRIC around that value. An earlier version quoted `lastPrice × U(1.0, 1.1)` to buy
 * and `× U(0.9, 1.0)` to sell, reading `lastPrice` back from its own prints — a feedback
 * loop with ±5% drift that compounded to €400 (short class) or €3 (long class) and had
 * nothing to do with the game's own parameters. Do not reintroduce asymmetric drift here.
 *
 *   node scripts/load-full-session.mjs
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

const INDUSTRIES = [
  'Power & Utilities',
  'Heavy Materials',
  'Manufacturing & Chemicals',
  'Transport',
]
// Six bots, not twenty-five. Measured: going 0 -> 5 bots drops one-sided ticks from 5.2%
// to 1.0% and tightens the spread 2.24 -> 1.84; going 5 -> 25 leaves one-sided at 1.0% and
// only reaches 1.39, for 5x the CPU and 3.7x the orders. Five or six is the knee.
const BOT_PLAN = [
  ['marketMaker', 2],
  ['compliance', 2],
  ['noise', 1],
  ['speculator', 1],
]

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (a, b) => a + Math.random() * (b - a)
const round1 = (n) => Math.round(n * 10) / 10
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
  connectFail: 0,
  snapshots: 0,
}
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
  constructor(sock, id, penaltyRate) {
    this.sock = sock
    this.id = id
    this.snap = null
    this.penaltyRate = penaltyRate
    sock.on('session:snapshot', (s) => {
      this.snap = s
      M.snapshots++
    })
  }

  /**
   * What this company thinks a tonne is worth: the cost of cutting it itself, capped by the
   * fine it would otherwise pay. This is the same valuation the engine's own bots and the
   * headless sim's students use, and it is what makes the penalty a ceiling *endogenously* —
   * nothing in the engine enforces one.
   */
  fairValue() {
    const s = this.snap
    const ref = this.refPrice()
    const spec = s?.abatement
    const rStar = optimalAbatement(ref, spec, s?.maxAbatement ?? 1)
    const mc = marginalCost(rStar, spec)
    if (mc === null) return ref
    return Math.min(this.penaltyRate, mc)
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
    const rStar = optimalAbatement(this.refPrice(), s.abatement, s.maxAbatement ?? 1)
    if (Math.random() < 0.3) {
      this.tally(await emit(this.sock, 'player:abate', { fraction: round1(rStar) }))
    }

    const need = expected * (1 - rStar) - held // >0 short, <0 surplus
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
    // Cold start matches the engine's own openingReference (penaltyRate × 0.5), not an
    // arbitrary 10 — otherwise the harness and the bots anchor to different prices.
    return mv?.lastPrice ?? mv?.vwap ?? s?.prevMarketPrice ?? s?.auctionPrice
      ?? this.penaltyRate * 0.5
  }

  tally(res) {
    if (!res) return
    if (res.ok) M.accepted++
    else if (/no shorting|at most|phase|not allowed|WRONG|INSUFFICIENT/i.test(res.error || '')) M.rejected4xx++
    else M.errors++
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
  const penaltyRate = hostSnap?.config?.penaltyRate ?? 100
  console.log(`penalty rate in force: ${penaltyRate}`)

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
          return new Player(sock, j.playerId, penaltyRate)
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
    console.log(`added 6 bots (2 marketMaker / 2 compliance / 1 noise / 1 speculator)`)
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
  // Wake the (possibly sleeping) Render instance first.
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) break
    } catch { /* retry */ }
    if (i === 9) throw new Error('backend /healthz never responded')
    await sleep(5000)
  }

  await runSession('grandfathering', { withBots: false, joinGrace: JOIN_GRACE })
  await runSession('benchmarking', { withBots: true, joinGrace: JOIN_GRACE })
  await runSession('auctioning', { withBots: true, joinGrace: JOIN_GRACE })

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

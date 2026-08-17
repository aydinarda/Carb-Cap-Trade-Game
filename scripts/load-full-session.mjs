/**
 * Full-session load test — Carbon Cap & Trade (socket.io backend)
 *
 * Classroom-paced, end-to-end load, run against the DEPLOYED backend so you can join
 * in a browser and feel the latency while 100 simulated players hammer the server.
 *
 * Three sequential sessions (one per cap mechanism), because host:addBots is lobby-only:
 *   1. grandfathering — 1 host + 100 players, a few years played to completion
 *   2. benchmarking   — same
 *   3. auctioning     — same + 25 bots (15 noise / 5 compliance / 3 speculator / 2 marketMaker)
 *
 * Each session: create → 100 players join → (bots) → a JOIN grace window (join in the
 * browser now!) → per year: cap stage (auction bids) → trade window (players place
 * bids/asks + abate at a relaxed cadence) → settle → advance → endGame.
 *
 * The players get session:snapshot pushed (no polling); we drive their ACTIONS and
 * measure the ack round-trip. Expected 4xx (no-shorting, wrong-phase races) are counted
 * separately, not as failures.
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
const JOIN_GRACE = Number(process.env.JOIN_GRACE || 15) // seconds to join in a browser before year 1

const INDUSTRIES = [
  'Power & Utilities',
  'Heavy Materials',
  'Manufacturing & Chemicals',
  'Transport',
]
const BOT_PLAN = [
  ['noise', 15],
  ['compliance', 5],
  ['speculator', 3],
  ['marketMaker', 2],
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
class Player {
  constructor(sock, id) {
    this.sock = sock
    this.id = id
    this.snap = null
    sock.on('session:snapshot', (s) => {
      this.snap = s
      M.snapshots++
    })
  }

  /** Auctioning cap stage: submit one sealed bid around the reference price. */
  async submitAuctionBid() {
    const y = this.snap?.you
    const expected = y?.expectedEmission ?? 100
    const ref = this.refPrice()
    const res = await emit(
      this.sock,
      'player:submitBid',
      { qty: round1(expected * rand(0.6, 1.0)), price: round1(ref * rand(0.9, 1.15)) },
      { measure: true },
    )
    this.tally(res)
  }

  /** Trade window: cover a shortfall (bid) or sell a surplus (ask); sometimes abate. */
  async tradeTick() {
    const s = this.snap
    if (!s || s.phase !== 'trade') return
    const y = s.you
    const held = y?.creditsHeld ?? 0
    const expected = y?.expectedEmission ?? 0
    const ref = this.refPrice()
    const need = expected - held // >0 short, <0 surplus

    if (need > 1) {
      const qty = round1(clamp(need * rand(0.3, 1), 1, need))
      this.tally(await emit(this.sock, 'player:placeOrder',
        { side: 'buy', qty, price: round1(ref * rand(1.0, 1.1)) }, { measure: true }))
    } else if (need < -1) {
      // Stay well under holdings so the no-shorting guard rarely trips.
      const qty = round1(clamp(-need * rand(0.3, 1), 1, held * 0.8))
      if (qty >= 1) this.tally(await emit(this.sock, 'player:placeOrder',
        { side: 'sell', qty, price: round1(ref * rand(0.9, 1.0)) }, { measure: true }))
    }
    if (Math.random() < 0.2) {
      this.tally(await emit(this.sock, 'player:abate', { fraction: round1(rand(0, 0.5)) }))
    }
  }

  refPrice() {
    const s = this.snap
    const mv = s?.market
    return mv?.lastPrice ?? mv?.vwap ?? s?.prevMarketPrice ?? s?.auctionPrice ?? 10
  }

  tally(res) {
    if (!res) return
    if (res.ok) M.accepted++
    else if (/no shorting|at most|phase|not allowed|WRONG|INSUFFICIENT/i.test(res.error || '')) M.rejected4xx++
    else M.errors++
  }
}

// ── one full session for a given cap mode ────────────────────────────────────
async function runSession(capMode, { withBots }) {
  console.log(`\n══════════ ${capMode.toUpperCase()} ══════════`)
  const host = await connect({ role: 'host' })
  const created = await emit(host, 'host:createSession', { hostKey: HOST_KEY, capMode })
  if (!created.ok) throw new Error(`createSession failed: ${created.error} (check HOST_KEY)`)
  const roomCode = created.roomCode

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
          return new Player(sock, j.playerId)
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
    console.log(`added 25 bots (15 noise / 5 compliance / 3 speculator / 2 marketMaker)`)
  }

  // ── JOIN WINDOW: hop in as a player now ──
  const joinHint = FRONTEND_URL ? `${FRONTEND_URL}  →  ` : ''
  console.log(`\n  ┌─────────────────────────────────────────────┐`)
  console.log(`  │  JOIN NOW → room code:  ${roomCode.padEnd(20)}│`)
  console.log(`  └─────────────────────────────────────────────┘`)
  console.log(`  ${joinHint}enter the code above (${JOIN_GRACE}s grace)\n`)
  await sleep(JOIN_GRACE * 1000)

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
    console.log(`  year ${year}/${YEARS_PER_MODE} settled` + (lb ? ` | leader ${lb[0]?.name} (${lb[0]?.normalizedScore})` : ''))
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

  await runSession('grandfathering', { withBots: false })
  await runSession('benchmarking', { withBots: false })
  await runSession('auctioning', { withBots: true })

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

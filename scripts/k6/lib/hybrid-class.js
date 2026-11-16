/**
 * One hybrid classroom game under load, for k6.
 *
 * setup()   creates a hybrid room as the host, adds the bots (every type) and every RL agent
 *           model the server ships (one company each), and returns the room code.
 * host      one VU: waits for the class to join, then plays YEARS rounds on a classroom clock
 *           (cap stage → market → year summary) and ends the game.
 * student   N VUs: join during the lobby, then bid at the auction, toggle borrowing, trade and
 *           abate the way the simulated students in scripts/load-full-session.mjs do: value a
 *           tonne at min(penalty, MAC at the cost-minimising cut), quote with symmetric noise.
 * health    GET /healthz every 2 s for the whole run; it shares the event loop with the game,
 *           so it is what Render's health check sees.
 *
 * Every knob is an environment variable (see README.md next to this folder).
 */
import http from 'k6/http'
import { check, fail } from 'k6'
import exec from 'k6/execution'
import { Counter, Gauge, Rate } from 'k6/metrics'
import { connect, wait } from './socketio.js'

const env = (key, fallback) => (__ENV[key] !== undefined && __ENV[key] !== '' ? __ENV[key] : fallback)
const num = (key, fallback) => Number(env(key, fallback))

export const BASE_URL = env('BASE_URL', 'http://localhost:3001').replace(/\/$/, '')
const HOST_KEY = env('HOST_KEY', 'admin123') // the live backend's key, as in scripts/load-full-session.mjs
const YEARS = num('YEARS', 12)
const CAP_WINDOW = num('CAP_WINDOW', 20) // s, cap stage (auction)
const ROUND_WINDOW = num('ROUND_WINDOW', 45) // s, market; the agents need 31 s for their 15 decisions
const REVIEW_GAP = num('REVIEW_GAP', 10) // s, year summary
const TRADE_MIN = num('TRADE_MIN', 3) // s, a student acts every U(TRADE_MIN, TRADE_MAX) s in the market
const TRADE_MAX = num('TRADE_MAX', 8)
const JOIN_SPREAD = num('JOIN_SPREAD', 20) // s, students arrive spread over this
const JOIN_TIMEOUT = num('JOIN_TIMEOUT', 120) // s, the host starts once all joined or after this
const START_DELAY = num('START_DELAY', 0) // s, year 1 never starts earlier: time for a person to join the lobby
const FRONTEND_URL = env('FRONTEND_URL', '').replace(/\/$/, '') // the game's site, for the join hint in the log
const MARKET_LOG_EVERY = num('MARKET_LOG_EVERY', 15) // s between market lines in the log
const AGENTS = env('AGENTS', 'all') // 'all' = every hybrid model once, 'none', or a comma list of model ids
const BOTS = env('BOTS', 'compliance:28,marketMaker:4,speculator:2,noise:6')

const INDUSTRIES = ['Power & Utilities', 'Heavy Materials', 'Manufacturing & Chemicals', 'Transport']
const BOT_TYPES = ['compliance', 'marketMaker', 'speculator', 'noise']
/** Refusals a real student also gets: racing the clock, selling what is already offered, … */
const EXPECTED = new Set([
  'INSUFFICIENT_CREDITS', 'WRONG_PHASE', 'NO_ORDER', 'BAD_ORDER', 'ABATE_DOWN', 'BAD_ABATE',
  'PERMANENT', 'BAD_BID', 'WRONG_MODE',
])

/** Every student join that was accepted. */
const joinOk = new Rate('join_ok')
/** Acks that were neither accepted nor an expected refusal (incl. timeouts and closed sockets). */
const ackFailed = new Rate('ack_failed')
const accepted = new Counter('actions_accepted')
const expectedRejects = new Counter('actions_expected_rejects')
/** The host played every year and ended the game without a refused transition. */
const gameCompleted = new Rate('game_completed')
/** Students who saw the game end before their deadline. */
const sawEnd = new Rate('student_saw_end')
const classJoined = new Gauge('class_joined')
const leaderboardMax = new Gauge('leaderboard_max_points')

const rand = (a, b) => a + Math.random() * (b - a)
const round1 = (x) => Math.round(x * 10) / 10
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/** The longest the lobby may last, in s: the start delay, or the class's join window if longer. */
const lobbySeconds = () => Math.max(START_DELAY, JOIN_SPREAD + JOIN_TIMEOUT)

/** Seconds the whole run may take: the lobby, every year, and a margin (≈ 19 min at the defaults). */
export function gameSeconds() {
  return Math.ceil(lobbySeconds() + YEARS * (CAP_WINDOW + ROUND_WINDOW + REVIEW_GAP + 5) + 60)
}

const K6_NAME = 'k6 student'
const fmt = (x, digits = 1) => (x === null || x === undefined ? '—' : Number(x).toFixed(digits))

/** Who a roster or leaderboard row is: a k6 student, an RL agent, a bot, or a person. */
function kindOf(row) {
  if (row.isBot) return row.botType || 'bot'
  if (row.agentModel || /^RL /.test(row.name)) return 'agent'
  if (row.name.startsWith(K6_NAME)) return 'k6'
  return 'person'
}

function topOf(leaderboard, n) {
  return (leaderboard || [])
    .filter((r) => r.points !== null)
    .slice(0, n)
    .map((r, i) => `${i + 1}. ${r.name} (${kindOf(r)}) ${fmt(r.points, 0)}`)
    .join(' · ')
}

function parseBots(spec) {
  const out = {}
  for (const part of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [type, count] = part.split(':').map((x) => x.trim())
    if (!BOT_TYPES.includes(type) || !(Number(count) >= 0)) fail(`bad BOTS entry "${part}"`)
    out[type] = Number(count)
  }
  return out
}

/** Keeps the latest pushed snapshot as text and parses it only when asked. */
function snapshotHolder() {
  let raw = null
  let parsed = null
  return {
    onSnapshot: (body) => { raw = body; parsed = null },
    get() {
      if (raw !== null && parsed === null) parsed = JSON.parse(raw)[1]
      return parsed
    },
  }
}

function tally(res, event) {
  const ok = !!res && res.ok === true
  const expected = !ok && !!res && EXPECTED.has(res.code)
  if (ok) accepted.add(1, { event })
  else if (expected) expectedRejects.add(1, { event, code: res.code })
  else console.warn(`${event}: ${res ? `${res.code || '—'} ${res.error}` : 'no response'}`)
  ackFailed.add(!ok && !expected, { event })
  return ok
}

// ---- the student's economics (mirrors scripts/load-full-session.mjs) ----

function marginalCost(f, spec) {
  const p = spec.params || spec
  switch (spec.model || 'linear') {
    case 'power': return p.a + p.b * Math.pow(f, p.n)
    case 'exponential': return p.a * Math.exp(p.k * f)
    default: return p.a + p.b * f
  }
}

function optimalAbatement(price, spec, maxFraction) {
  const p = spec.params || spec
  let r
  switch (spec.model || 'linear') {
    case 'power': r = p.b > 0 ? Math.pow(Math.max(0, (price - p.a) / p.b), 1 / p.n) : 0; break
    case 'exponential': r = p.k > 0 && p.a > 0 ? Math.log(Math.max(1e-9, price / p.a)) / p.k : 0; break
    default: r = p.b > 0 ? (price - p.a) / p.b : 0
  }
  return clamp(r, 0, clamp(maxFraction, 0, 1))
}

function refPrice(s) {
  const mv = s.market
  return (mv && (mv.lastPrice ?? mv.vwap)) ?? s.prevMarketPrice ?? s.auctionPrice ?? s.penaltyRate * 0.25
}

/** What a tonne is worth to this company: its own cost of cutting it, never above the fine. */
function fairValue(s) {
  const ref = refPrice(s)
  if (!s.abatement) return Math.min(s.penaltyRate, ref)
  const r = optimalAbatement(ref, s.abatement, s.abatementLifetimeCap ?? 1)
  return Math.max(0.5, Math.min(s.penaltyRate, marginalCost(r, s.abatement)))
}

async function auctionBid(client, s) {
  const y = s.you
  const residual = (y.plannedEmission ?? 0) - (y.freeAllocation ?? 0) - (y.banked ?? 0)
  if (residual < 1) return
  const fair = fairValue(s)
  if (Math.random() < 0.3) {
    tally(await client.emit('player:submitBid', { qty: round1(residual * rand(0.6, 1)), price: round1(fair * rand(0.92, 1.08)) }), 'player:submitBid')
    return
  }
  // A three-step sweep: most at about the fair value, the rest cheaper.
  const steps = [[0.5, rand(1.0, 1.08)], [0.3, rand(0.88, 0.96)], [0.2, rand(0.75, 0.85)]]
    .map(([w, m]) => ({ qty: round1(residual * w), price: round1(fair * m) }))
    .filter((st) => st.qty > 0 && st.price > 0)
  if (steps.length) tally(await client.emit('player:submitBid', { steps }), 'player:submitBid')
}

async function tradeTick(client, s) {
  const y = s.you
  const fair = fairValue(s)

  // Sometimes pull a resting order of ours.
  const mine = s.market ? [...s.market.bids, ...s.market.asks].filter((o) => o.playerId === y.id) : []
  if (mine.length && Math.random() < 0.15) {
    const o = mine[Math.floor(Math.random() * mine.length)]
    tally(await client.emit('player:cancelOrder', { orderId: o.id }), 'player:cancelOrder')
    return
  }

  // Abate towards the cost-minimising cut; capacity is permanent, so only ever upwards.
  if (s.abatement) {
    const target = optimalAbatement(refPrice(s), s.abatement, s.abatementLifetimeCap ?? 1)
    if (target > (y.abatementCommitted ?? 0) + 0.01 && Math.random() < 0.3) {
      tally(await client.emit('player:abate', { fraction: round1(target) }), 'player:abate')
      return
    }
  }

  const held = y.creditsHeld ?? 0
  const need = (y.plannedEmission ?? 0) - held
  if (need > 1) {
    const qty = round1(clamp(need * rand(0.3, 1), 1, need))
    tally(await client.emit('player:placeOrder', { side: 'buy', qty, price: round1(fair * rand(0.95, 1.05)) }), 'player:placeOrder')
  } else if (need < -1 && held > 1) {
    const qty = round1(clamp(-need * rand(0.3, 1), 1, held * 0.8))
    tally(await client.emit('player:placeOrder', { side: 'sell', qty, price: round1(fair * rand(0.95, 1.05)) }), 'player:placeOrder')
  } else if (Math.random() < 0.6) {
    // Covered: keep trading for the whole window, as a class does — small orders off the fair
    // value, a cheap buy or (from what it holds) a dear sell.
    const sell = held > 2 && Math.random() < 0.5
    const qty = round1(rand(1, sell ? Math.min(5, held * 0.5) : 5))
    const price = round1(fair * (sell ? rand(1.03, 1.15) : rand(0.85, 0.97)))
    tally(await client.emit('player:placeOrder', { side: sell ? 'sell' : 'buy', qty, price }), 'player:placeOrder')
  }
}

// ---- the test ----

/**
 * Everything one entry file needs, for a class of `students`.
 * The entry re-exports `options`, `setup`, `host`, `student` and `health`.
 */
export function makeTest(students) {
  const total = gameSeconds()

  const options = {
    // A sleeping Render free instance takes up to a minute to answer the first request.
    setupTimeout: '300s',
    scenarios: {
      host: { executor: 'per-vu-iterations', exec: 'host', vus: 1, iterations: 1, maxDuration: `${total}s` },
      students: { executor: 'per-vu-iterations', exec: 'student', vus: students, iterations: 1, maxDuration: `${total}s` },
      health: { executor: 'constant-arrival-rate', exec: 'health', rate: 1, timeUnit: '2s', duration: `${total}s`, preAllocatedVUs: 2, maxVUs: 4 },
    },
    thresholds: {
      'ack_rtt{scenario:students}': ['p(95)<500', 'p(99)<1500'],
      'ack_rtt{scenario:host}': ['p(95)<1000'],
      'http_req_duration{name:healthz}': ['p(95)<1000'],
      'checks{check:healthz 200}': ['rate>0.99'],
      join_ok: ['rate>0.99'],
      ack_failed: ['rate<0.01'],
      ws_connect_failures: ['count<1'],
      game_completed: ['rate==1'],
      student_saw_end: ['rate>0.99'],
    },
    summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  }

  async function setup() {
    if (!HOST_KEY) fail('HOST_KEY is not set')
    const bots = parseBots(BOTS)
    const warm = http.get(`${BASE_URL}/healthz`, { timeout: '120s', tags: { name: 'warmup' } })
    if (warm.status !== 200) fail(`backend did not answer /healthz: ${warm.status}`)

    const snap = snapshotHolder()
    const hostSocket = await connect(BASE_URL, null, { onSnapshot: snap.onSnapshot })
    const created = await hostSocket.emit('host:createSession', { hostKey: HOST_KEY, capMode: 'hybrid' })
    if (!created.ok) fail(`createSession: ${created.code} ${created.error}`)

    for (const type of BOT_TYPES) {
      let left = bots[type] || 0
      while (left > 0) {
        const n = Math.min(20, left) // the server adds at most 20 per call
        const res = await hostSocket.emit('host:addBots', { botType: type, count: n })
        if (!res.ok) fail(`addBots ${type}: ${res.code} ${res.error}`)
        left -= n
      }
    }

    // The host snapshot lists the models the server can run.
    let s = null
    for (let i = 0; i < 50 && !(s = snap.get()); i++) await wait(100)
    if (!s) fail('no host snapshot after creating the room')
    const runnable = s.rlModels.filter((m) => m.mode === 'hybrid' && m.error === null).map((m) => m.id)
    const wanted = AGENTS === 'none' ? [] : AGENTS === 'all' ? runnable : AGENTS.split(',').map((x) => x.trim())
    for (const id of wanted) {
      if (!runnable.includes(id)) fail(`agent model ${id} is not on the server`)
      const res = await hostSocket.emit('host:addAgents', { model: id, count: 1 })
      if (!res.ok) fail(`addAgents ${id}: ${res.code} ${res.error}`)
    }

    await wait(500)
    const roster = snap.get().players
    const botCount = roster.filter((p) => p.isBot).length
    const agentCount = roster.filter((p) => p.agentModel).length
    hostSocket.close()
    const site = FRONTEND_URL || 'the game\'s site'
    const identity = JSON.stringify({ role: 'host', roomCode: created.roomCode, token: created.hostToken })
    for (const line of [
      `════════ ROOM ${created.roomCode} ════════`,
      `${students} k6 students · ${botCount} bots (${BOTS}) · ${agentCount} RL agents · ${YEARS} years × (cap ${CAP_WINDOW} s + market ${ROUND_WINDOW} s + summary ${REVIEW_GAP} s)`,
      `Year 1 starts in about ${Math.max(START_DELAY, JOIN_SPREAD)} s (once all k6 students are in and the start delay has passed). Joining closes then.`,
      `PLAY:  open ${site}, enter room ${created.roomCode}, any name and industry.`,
      `WATCH as host, in another browser or a private window: open ${site}, then run in the browser console:`,
      `  localStorage.setItem('capgame:identity', '${identity}'); location.href = '/host'`,
      `  The test drives the clock: watch, but do not press the host buttons.`,
      `══════════════════════════════`,
    ]) console.log(line)
    return { roomCode: created.roomCode, hostToken: created.hostToken, students, botCount, agentCount }
  }

  async function host(data) {
    const snap = snapshotHolder()
    const client = await connect(BASE_URL, { role: 'host', token: data.hostToken }, { onSnapshot: snap.onSnapshot })

    // Lobby: wait for the class, and for the start delay so a person can join too.
    const roster = () => {
      const s = snap.get()
      return s ? s.players : []
    }
    const t0 = Date.now()
    const people = new Set()
    let nextLog = 0
    for (;;) {
      const players = roster()
      const k6In = players.filter((p) => kindOf(p) === 'k6').length
      for (const p of players) {
        if (kindOf(p) === 'person' && !people.has(p.id)) {
          people.add(p.id)
          console.log(`lobby · a person joined: ${p.name} (${p.industry})`)
        }
      }
      const elapsed = (Date.now() - t0) / 1000
      if ((k6In >= data.students && elapsed >= START_DELAY) || elapsed >= lobbySeconds()) {
        classJoined.add(k6In)
        console.log(`lobby closed · k6 students ${k6In}/${data.students} · people ${people.size}`)
        break
      }
      if (elapsed >= nextLog) {
        console.log(`lobby · year 1 in ${Math.max(1, Math.ceil(Math.max(START_DELAY - elapsed, 0)))} s or more · k6 students ${k6In}/${data.students} · people ${people.size} · room ${data.roomCode}`)
        nextLog += 30
      }
      await wait(1000)
    }

    let allOk = true
    const step = async (event) => {
      const res = await client.emit(event, {})
      if (!res.ok) {
        allOk = false
        console.error(`${event} refused: ${res.code} ${res.error}`)
      }
    }
    const marketLine = (label) => {
      const s = snap.get()
      const mv = s && s.market
      const reserve = s && s.classAggregate ? s.classAggregate.reserveReleased : null
      console.log(`${label} · last ${fmt(mv && mv.lastPrice)} € · VWAP ${fmt(mv && mv.vwap)} € · volume ${fmt(mv && mv.volume, 0)} t · ` +
        `bid/ask ${fmt(mv && mv.bestBid)}/${fmt(mv && mv.bestAsk)} € · reserve sold ${fmt(reserve, 0)} t`)
    }
    for (let y = 0; y < YEARS; y++) {
      await step(y === 0 ? 'host:startYear' : 'host:advanceYear')
      console.log(`──── year ${y + 1}/${YEARS} ──── cap stage (auction) ${CAP_WINDOW} s`)
      await wait(CAP_WINDOW * 1000)
      await step('host:closeCapStage')
      await wait(300)
      const cap = snap.get()
      console.log(`auction cleared at ${fmt(cap && cap.auctionPrice)} € · pool ${fmt(cap && cap.regulatorPool, 0)} t`)
      await step('host:openTrade')
      console.log(`market open ${ROUND_WINDOW} s`)
      const marketEnd = Date.now() + ROUND_WINDOW * 1000
      const marketStart = Date.now()
      while (Date.now() < marketEnd - 1000) {
        await wait(Math.min(MARKET_LOG_EVERY * 1000, marketEnd - Date.now()))
        if (Date.now() < marketEnd - 1000) marketLine(`market +${Math.round((Date.now() - marketStart) / 1000)} s`)
      }
      await wait(Math.max(0, marketEnd - Date.now()))
      await step('host:closeTrade')
      await wait(500)
      marketLine(`year ${y + 1} settled`)
      const settled = snap.get()
      const connected = settled ? settled.players.filter((p) => !p.isBot && !p.agentModel && p.connected).length : 0
      console.log(`  top: ${topOf(settled && settled.leaderboard, 3)} · connected students and people: ${connected}`)
      await wait(Math.max(0, REVIEW_GAP * 1000 - 800))
    }
    await step('host:endGame')
    await wait(1500)

    const s = snap.get()
    const rows = (s && s.leaderboard ? s.leaderboard : []).filter((r) => r.points !== null)
    const top = rows.reduce((m, r) => Math.max(m, r.points), 0)
    leaderboardMax.add(top)
    console.log(`════════ GAME OVER · room ${data.roomCode} ════════`)
    console.log(`top 5: ${topOf(rows, 5)}`)
    console.log(`${rows.length} ranked · max points ${fmt(top)} · above 1,000: ${rows.filter((r) => r.points > 1000).length}`)
    for (const r of rows.filter((x) => kindOf(x) === 'person')) {
      console.log(`  you: ${r.name} · rank ${rows.indexOf(r) + 1} of ${rows.length} · ${fmt(r.points, 0)} points`)
    }
    gameCompleted.add(allOk && !!s && s.phase === 'ended')
    client.close()
  }

  async function student(data) {
    const id = exec.vu.idInTest
    const deadline = Date.now() + total * 1000
    await wait(rand(0, JOIN_SPREAD) * 1000)

    const snap = snapshotHolder()
    let client
    try {
      client = await connect(BASE_URL, null, { onSnapshot: snap.onSnapshot })
    } catch (e) {
      joinOk.add(false)
      console.error(`student ${id}: ${e.message}`)
      return
    }
    const joined = await client.emit('player:join', {
      roomCode: data.roomCode,
      name: `k6 student ${id}`,
      industry: INDUSTRIES[id % INDUSTRIES.length],
    })
    joinOk.add(joined.ok === true)
    if (!joined.ok) {
      console.error(`student ${id} could not join: ${joined.code} ${joined.error}`)
      client.close()
      return
    }

    let bidYear = null
    let borrowYear = null
    let nextTradeAt = 0
    let ended = false
    while (client.open && Date.now() < deadline) {
      await wait(1000)
      const s = snap.get()
      if (!s) continue
      if (s.phase === 'ended') { ended = true; break }
      if (s.phase === 'cap' && borrowYear !== s.currentYear) {
        borrowYear = s.currentYear
        // Most leave borrowing on (the default); some switch it off for the year.
        if (Math.random() < 0.3) tally(await client.emit('player:setBorrow', { on: Math.random() < 0.5 }), 'player:setBorrow')
      }
      if (s.phase === 'cap' && s.usesAuction && bidYear !== s.currentYear) {
        bidYear = s.currentYear
        await wait(rand(1, Math.max(1.5, CAP_WINDOW * 0.6)) * 1000)
        const now = snap.get()
        if (now && now.phase === 'cap') await auctionBid(client, now)
      }
      if (s.phase === 'trade' && Date.now() >= nextTradeAt) {
        nextTradeAt = Date.now() + rand(TRADE_MIN, TRADE_MAX) * 1000
        await tradeTick(client, s)
      }
    }
    sawEnd.add(ended)
    client.close()
  }

  function health() {
    const res = http.get(`${BASE_URL}/healthz`, { timeout: '10s', tags: { name: 'healthz' } })
    check(res, { 'healthz 200': (r) => r.status === 200 })
  }

  return { options, setup, host, student, health }
}

/**
 * Grandfathering smoke test — bots were previously inert here because
 * `grandfathering.primaryPrice()` returned 0, which made the trader-bot seed grant bail
 * and left the market maker with no inventory to quote asks against.
 *
 * Run against a dev server: `node scripts/gf-smoke.mjs`
 */
import { io } from 'socket.io-client'
const URL = process.env.BASE_URL || 'http://localhost:3001'
const HOST_KEY = process.env.HOST_KEY || 'letmein'
const call = (s, e, p = {}) =>
  new Promise((r, j) => s.emit(e, p, (x) => (x.ok ? r(x) : j(new Error(x.error)))))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${msg}`)
  if (!cond) fails++
}

const host = io(URL, { auth: { role: 'host' } })
await new Promise((r) => host.on('connect', r))
let hs = null
host.on('session:snapshot', (x) => {
  if (x.role === 'host') hs = x
})
const { roomCode } = await call(host, 'host:createSession', {
  hostKey: HOST_KEY,
  capMode: 'grandfathering',
})

await call(host, 'host:addBots', { botType: 'compliance', count: 4 })
await call(host, 'host:addBots', { botType: 'marketMaker', count: 2 })
await call(host, 'host:addBots', { botType: 'noise', count: 2 })
await wait(80)
ok(hs.players.filter((p) => p.isBot).length === 8, 'bots can be added under GRANDFATHERING')

const human = io(URL)
await new Promise((r) => human.on('connect', r))
let ph = null
human.on('session:snapshot', (x) => {
  if (x.role === 'player') ph = x
})
await call(human, 'player:join', { roomCode, name: 'Alice', industry: 'Power & Utilities' })

await call(host, 'host:startYear')
await wait(300)
ok(hs.regulatorPool === 0, `no primary supply: regulatorPool = ${hs.regulatorPool}`)
ok(ph.you.freeAllocation > 0, `human is grandfathered ${ph.you.freeAllocation} cr`)
ok(ph.sectorBenchmark === null, 'no benchmark fields outside benchmarking')

const traders = hs.players.filter((p) => p.botType === 'marketMaker')
ok(
  traders.every((p) => p.freeAllocation === 0),
  'trader bots draw no grandfathered allocation (no real history)',
)
ok(
  traders.every((p) => p.regulatorGranted > 0),
  `trader bots bought an opening book: ${traders.map((p) => p.regulatorGranted).join(' ')}`,
)

await call(host, 'host:closeCapStage')
await call(host, 'host:openTrade')
await wait(26000) // ~10 bot ticks

const P = 20
const mv = hs.market
const prices = mv.trades.map((t) => t.price)
ok(mv.trades.length > 0, `bots traded under grandfathering: ${mv.trades.length} trades`)
ok(
  prices.every((p) => p > 0 && p <= P),
  `all prices in (0, ${P}]  [min ${Math.min(...prices)}, max ${Math.max(...prices)}]`,
)
ok(mv.bids.length > 0 && mv.asks.length > 0, `book is TWO-SIDED: ${mv.bids.length}/${mv.asks.length}`)
const mmIds = traders.map((p) => p.id)
ok(mv.asks.some((o) => mmIds.includes(o.playerId)), 'a market maker is resting an ASK')
console.log(`  vwap ${mv.vwap} · last ${mv.lastPrice} · volume ${mv.volume}`)

await call(human, 'player:placeOrder', { side: 'buy', qty: 10, price: P })
await wait(3500)
ok((ph.you.myTrades?.length ?? 0) > 0, `human found a counterparty: ${ph.you.myTrades?.length ?? 0}`)

await call(host, 'host:closeTrade')
await wait(120)
const mm = hs.players.find((p) => p.botType === 'marketMaker')
ok(mm.settlement.purchaseCost > 0, `MM was charged for its seed: ${mm.settlement.purchaseCost}`)
ok(
  hs.players.every((p) => Number.isFinite(p.score)),
  'all scores finite after settlement',
)

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURES`}`)
host.close()
human.close()
process.exit(fails === 0 ? 0 : 1)

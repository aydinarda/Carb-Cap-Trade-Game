import { io } from 'socket.io-client'
const URL = 'http://localhost:3001'
const call = (s, e, p = {}) => new Promise((r, j) => s.emit(e, p, (x) => (x.ok ? r(x) : j(new Error(x.error)))))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) fails++ }

const host = io(URL, { auth: { role: 'host' } })
await new Promise((r) => host.on('connect', r))
let hs = null
host.on('session:snapshot', (x) => { if (x.role === 'host') hs = x })
const { roomCode } = await call(host, 'host:createSession', { hostKey: 'letmein', capMode: 'benchmarking' })

await call(host, 'host:addBots', { botType: 'compliance', count: 4 })
await call(host, 'host:addBots', { botType: 'marketMaker', count: 2 })
await call(host, 'host:addBots', { botType: 'speculator', count: 1 })
await call(host, 'host:addBots', { botType: 'noise', count: 2 })
await wait(80)
ok(hs.players.filter((p) => p.isBot).length === 9, `9 bots added under BENCHMARKING (was auctioning-only)`)

const human = io(URL)
await new Promise((r) => human.on('connect', r))
let ph = null
human.on('session:snapshot', (x) => { if (x.role === 'player') ph = x })
await call(human, 'player:join', { roomCode, name: 'Alice', industry: 'Power & Utilities' })

// ===== CAP =====
await call(host, 'host:startYear')
await wait(6000) // ~2 bot ticks: nothing should happen, there is no auction
ok(hs.regulatorPool === 0, `no primary supply: regulatorPool = ${hs.regulatorPool}`)
ok(hs.classAggregate.submittedCount === 0, `no cap-stage bids: submittedCount = ${hs.classAggregate.submittedCount}`)
ok(ph.sectorBenchmark === 600, `human's sector benchmark = ${ph.sectorBenchmark} (Power & Utilities)`)
ok(ph.sectorAverage === 1000, `sector average = ${ph.sectorAverage} → 40% below`)
ok(ph.you.freeAllocation === 600, `human free allocation = ${ph.you.freeAllocation}`)
ok(ph.you.expectedEmission > ph.you.freeAllocation,
   `human opens SHORT: expected ${ph.you.expectedEmission} vs ${ph.you.freeAllocation} allocated`)

const traders = hs.players.filter((p) => p.botType === 'marketMaker' || p.botType === 'speculator')
ok(traders.every((p) => p.freeAllocation === 0), `trader bots get 0 free allocation`)
ok(traders.every((p) => p.regulatorGranted > 0),
   `trader bots bought a seed book: ${traders.map((p) => `${p.botType}=${p.regulatorGranted}`).join(' ')}`)
const emitterBots = hs.players.filter((p) => p.botType === 'compliance' || p.botType === 'noise')
ok(emitterBots.every((p) => p.freeAllocation > 0), `emitter bots get their sector benchmark`)

const agg = hs.classAggregate
ok(agg.totalFreeAllocation < agg.totalExpected,
   `class is structurally short: ${agg.totalFreeAllocation} cr vs ${agg.totalExpected} t expected`)

await call(host, 'host:closeCapStage')
await call(host, 'host:openTrade')

// ===== TRADE =====
await wait(26000) // ~10 bot ticks
// Read the ceiling from the running server rather than hardcoding it — these scripts
// silently went stale when penaltyRate moved from 20 to 100.
const P = hs.config.penaltyRate
const mv = hs.market
const prices = mv.trades.map((t) => t.price)
ok(mv.trades.length > 0, `trades happened without any auction: ${mv.trades.length}`)
ok(prices.every((p) => p > 0 && p <= P), `all prices in (0, ${P}]  [min ${Math.min(...prices)}, max ${Math.max(...prices)}]`)
ok(mv.bids.length > 0 && mv.asks.length > 0, `book is TWO-SIDED: ${mv.bids.length} bids / ${mv.asks.length} asks`)
const mmIds = hs.players.filter((p) => p.botType === 'marketMaker').map((p) => p.id)
ok(mv.asks.some((o) => mmIds.includes(o.playerId)), `a market maker is resting an ASK (circulatingCap fix)`)
ok(mv.bids.some((o) => mmIds.includes(o.playerId)), `a market maker is resting a BID`)
console.log(`  vwap ${mv.vwap} · last ${mv.lastPrice} · volume ${mv.volume}`)

await call(human, 'player:placeOrder', { side: 'buy', qty: 15, price: P })
await wait(3500)
ok((ph.you.myTrades?.length ?? 0) > 0, `human found a counterparty: ${ph.you.myTrades?.length ?? 0} trades`)

await call(host, 'host:closeTrade')
await wait(80)
const mm = hs.players.find((p) => p.botType === 'marketMaker')
ok(mm.settlement.purchaseCost > 0, `MM was CHARGED for its seed: purchaseCost = ${mm.settlement.purchaseCost}`)
ok(hs.classAggregate.yearHistory.length === 1, `year 11 recorded, cap = ${hs.classAggregate.yearHistory[0].cap}`)

// ===== YEAR 12: tightening =====
const y11Alloc = ph.you.freeAllocation
await call(host, 'host:advanceYear')
await wait(120)
ok(ph.you.freeAllocation === Math.round(y11Alloc * 0.97 * 10) / 10,
   `benchmark TIGHTENED 3%: ${y11Alloc} → ${ph.you.freeAllocation}`)
ok(ph.prevMarketPrice !== null && ph.prevMarketPrice > 0,
   `price signal carried into year 12: prevMarketPrice = ${ph.prevMarketPrice}`)
const mm12 = hs.players.find((p) => p.botType === 'marketMaker')
ok(!mm12.regulatorGranted, `no second seed grant in year 12 (got ${mm12.regulatorGranted})`)

await call(host, 'host:closeCapStage')
await call(host, 'host:openTrade')
await wait(13000) // ~5 ticks
ok(hs.market.trades.length > 0, `year 12 market also trades: ${hs.market.trades.length}`)
const y12cap = hs.classAggregate.yearHistory[0].cap

await call(host, 'host:closeTrade')
await wait(120)
const hist = hs.classAggregate.yearHistory
ok(hist.length === 2 && hist[1].cap < hist[0].cap,
   `chart cap line FALLS with the benchmark: ${hist[0].cap} → ${hist[1].cap}`)
void y12cap

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURES`}`)
host.close(); human.close()
process.exit(fails === 0 ? 0 : 1)

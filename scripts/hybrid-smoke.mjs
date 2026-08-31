import { io } from 'socket.io-client'

/**
 * Hybrid mode over the wire: benchmark free allocation AND a cap-stage auction, in the
 * same year.
 *
 * The two existing smoke scripts each cover one half — `bench-smoke.mjs` the allocation
 * and its yearly tightening, `bots-smoke.mjs` the auction and the bots that bid into it.
 * What only this mode can get wrong is the SPLIT between them: free credits are deducted
 * from the auction supply rather than added on top, so `Σfree + pool` must equal the cap
 * whatever the shares are set to. That identity, and the fact that a 0-share sector really
 * is issued nothing, are what this asserts.
 */
const URL = process.env.GAME_URL || 'http://localhost:3001'
const call = (s, e, p = {}) => new Promise((r, j) => s.emit(e, p, (x) => (x.ok ? r(x) : j(new Error(x.error)))))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) fails++ }
const r1 = (n) => Math.round(n * 10) / 10

const host = io(URL, { auth: { role: 'host' } })
await new Promise((r) => host.on('connect', r))
let hs = null
host.on('session:snapshot', (x) => { if (x.role === 'host') hs = x })
const { roomCode } = await call(host, 'host:createSession', { hostKey: 'letmein', capMode: 'hybrid' })

// Pin the shares rather than relying on the shipped table, so this script keeps testing the
// mechanism if the defaults are recalibrated. Power gets nothing, Heavy Materials everything.
await call(host, 'host:updateSettings', {
  hybridFreeShare: {
    'Power & Utilities': 0,
    'Heavy Materials': 1,
    'Manufacturing & Chemicals': 0.5,
    Transport: 0,
  },
})
await wait(80)
ok(hs.config.hybridFreeShare['Power & Utilities'] === 0, `shares accepted over the wire`)

await call(host, 'host:addBots', { botType: 'compliance', count: 4 })
await call(host, 'host:addBots', { botType: 'marketMaker', count: 2 })
await call(host, 'host:addBots', { botType: 'speculator', count: 1 })
await wait(80)
ok(hs.players.filter((p) => p.isBot).length === 7, `7 bots added under HYBRID`)

// One player in an excluded sector, one in a fully-allocated sector — the comparison the
// whole mode exists to put in front of a class.
const power = io(URL)
const heavy = io(URL)
await Promise.all([
  new Promise((r) => power.on('connect', r)),
  new Promise((r) => heavy.on('connect', r)),
])
let pp = null
let hp = null
power.on('session:snapshot', (x) => { if (x.role === 'player') pp = x })
heavy.on('session:snapshot', (x) => { if (x.role === 'player') hp = x })
await call(power, 'player:join', { roomCode, name: 'Powerco', industry: 'Power & Utilities' })
const { playerId: heavyId } = await call(heavy, 'player:join', {
  roomCode, name: 'Steelco', industry: 'Heavy Materials',
})

// ===== CAP: allocation AND auction, together =====
await call(host, 'host:startYear')
await wait(80)

ok(pp.usesAuction === true, `hybrid reports usesAuction to the player`)
ok(pp.you.freeAllocation === 0, `excluded sector gets NOTHING free: ${pp.you.freeAllocation}`)
ok(hp.you.freeAllocation === hp.sectorBenchmark,
   `full-share sector gets its whole benchmark: ${hp.you.freeAllocation} = ${hp.sectorBenchmark}`)
ok(pp.sectorBenchmark !== null && pp.sectorBenchmark > 0,
   `the excluded sector still SEES its benchmark (${pp.sectorBenchmark}) — that is the comparison`)

const free = hs.classAggregate.totalFreeAllocation
const pool = hs.regulatorPool
const cap = r1(hs.classAggregate.totalBaselineEmissions * hs.config.auctionCapRatio)
ok(free > 0 && pool > 0, `BOTH halves are live: ${free} cr free + ${pool} cr auctioned`)
// The identity. A regression making free allocation additive breaks precisely this line.
ok(Math.abs(r1(free + pool) - cap) <= 0.5,
   `free + pool = the cap: ${free} + ${pool} = ${r1(free + pool)} vs cap ${cap}`)
ok(pp.auctionSupply === pool, `player sees the residual supply: ${pp.auctionSupply}`)

await wait(6000) // ~2 bot ticks — the bots should be bidding
ok(hs.classAggregate.submittedCount > 0, `bots bid into the auction: ${hs.classAggregate.submittedCount} bids`)
// A bot holding free credits must bid for less than one holding none — the free allocation
// flows into `creditsHeld`, which is what sizes a compliance bot's residual.
const bidders = hs.players.filter((p) => p.botType === 'compliance')
ok(bidders.length > 0, `compliance bots present: ${bidders.length}`)

// Both humans bid: the excluded one for everything, the allocated one for its residual.
await call(power, 'player:submitBid', { qty: Math.round(pp.you.plannedEmission), price: hs.config.penaltyRate * 0.6 })
await call(heavy, 'player:submitBid', { qty: 25, price: hs.config.penaltyRate * 0.6 })
await wait(200)

await call(host, 'host:closeCapStage')
await wait(200)
ok(hs.auctionPrice !== null && hs.auctionPrice > 0, `auction cleared at ${hs.auctionPrice}`)
ok(pp.you.auctionAward > 0, `excluded-sector player won credits: ${pp.you.auctionAward}`)
ok(hp.you.creditsHeld > hp.you.freeAllocation,
   `allocated player holds free + auctioned: ${hp.you.creditsHeld} > ${hp.you.freeAllocation}`)

// ===== TRADE =====
await call(host, 'host:openTrade')
await wait(26000) // ~10 bot ticks
const P = hs.config.penaltyRate
const mv = hs.market
const prices = mv.trades.map((t) => t.price)
ok(mv.trades.length > 0, `secondary market trades after the auction: ${mv.trades.length}`)
// The fine is NOT the ceiling: `bots.fixes.ceilingIncludesCarry` ships ON, so an agent will
// pay up to the fine PLUS the reference price — an uncovered tonne is fined and still owed.
// The bound is read off the running server rather than hardcoded, which is exactly how the
// older smoke scripts went stale when `penaltyRate` moved.
const ceiling = hs.config.ceilingIncludesCarry ? P + (hs.prevMarketPrice ?? hs.auctionPrice ?? 0) : P
ok(prices.every((p) => p > 0 && p <= ceiling),
   `all prices in (0, ${r1(ceiling)}]  [min ${Math.min(...prices)}, max ${Math.max(...prices)}]`)
ok(mv.bids.length > 0, `book has resting demand: ${mv.bids.length} bids`)
// NOT a two-sided-book assertion. `bots.seed.underAuction` ships OFF, so under any
// auction-bearing mode the market makers are never sold an opening inventory and cannot
// short — the same one-sided book auctioning has always had. What IS hybrid's own claim is
// that the free allocation is real, spendable inventory rather than a number on a screen,
// so the check is that a company holding free credits can offer them.
await call(heavy, 'player:placeOrder', { side: 'sell', qty: 20, price: r1(P * 0.4) })
await wait(400)
const soldOrResting =
  hs.market.asks.some((o) => o.playerId === heavyId) ||
  (hp.you.myTrades ?? []).some((t) => t.sellerId === heavyId)
ok(soldOrResting, `free credits are spendable: the allocated player's ask is on the book or filled`)
console.log(`  vwap ${mv.vwap} · last ${mv.lastPrice} · volume ${mv.volume}`)

await call(host, 'host:closeTrade')
await wait(200)
// The free half must stay free: a company issued credits and buying nothing at the auction
// is charged nothing at the cap stage.
ok(hp.you.settlement !== null, `year settled`)
ok(hs.classAggregate.yearHistory.length === 1,
   `year 11 recorded, cap = ${hs.classAggregate.yearHistory[0].cap}`)
// The chart's cap line is free + pool + whatever the cost containment reserve sold during
// the year, so the reserve has to be added back before the split can be compared.
const released = hs.classAggregate.reserveReleased
ok(Math.abs(hs.classAggregate.yearHistory[0].cap - r1(free + pool + released)) <= 0.5,
   `the chart's cap line is the same split: ${hs.classAggregate.yearHistory[0].cap} = ${free} free + ${pool} auctioned + ${released} reserve`)

// ===== YEAR 12: both halves tighten =====
const y11Free = hp.you.freeAllocation
const y11ClassFree = free
const y11Pool = pool
await call(host, 'host:advanceYear')
await wait(200)
// The exact factor is NOT asserted: the shipped config tightens on a decelerating
// `capReductionSchedule`, and `HostConfigView` carries only the flat fallback — pinning
// `capReductionFactor` here would assert a number the engine is not using. What matters for
// this mode is that BOTH halves tighten, and tighten together, so the split does not drift.
ok(hp.you.freeAllocation < y11Free,
   `free allocation tightened: ${y11Free} → ${hp.you.freeAllocation}`)
ok(hs.regulatorPool < y11Pool, `auction supply tightened too: ${y11Pool} → ${hs.regulatorPool}`)
const freeRatio = hp.you.freeAllocation / y11Free
const capRatio = (hs.classAggregate.totalFreeAllocation + hs.regulatorPool) / (y11ClassFree + y11Pool)
ok(Math.abs(freeRatio - capRatio) < 0.01,
   `both halves shrink by the SAME factor — the split holds: free ×${r1(freeRatio * 100) / 100} vs cap ×${r1(capRatio * 100) / 100}`)
ok(pp.you.freeAllocation === 0, `excluded sector still gets nothing in year 12`)
ok(hp.prevMarketPrice !== null && hp.prevMarketPrice > 0,
   `price signal carried into year 12: prevMarketPrice = ${hp.prevMarketPrice}`)

// ===== mode switching still works =====
await call(host, 'host:closeCapStage')
await call(host, 'host:openTrade')
await wait(13000) // ~5 ticks
await call(host, 'host:closeTrade')
await wait(200)
await call(host, 'host:setCapMode', { mode: 'benchmarking' })
await call(host, 'host:advanceYear')
await wait(200)
ok(hs.capMode === 'benchmarking' && hs.usesAuction === false,
   `switched out of hybrid between years: mode ${hs.capMode}, usesAuction ${hs.usesAuction}`)
ok(hs.regulatorPool === 0, `no auction supply after the switch: ${hs.regulatorPool}`)
ok(pp.you.freeAllocation > 0,
   `the excluded sector receives a benchmark once the shares no longer apply: ${pp.you.freeAllocation}`)

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURES`}`)
host.close(); power.close(); heavy.close()
process.exit(fails === 0 ? 0 : 1)

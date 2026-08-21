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
const { roomCode } = await call(host, 'host:createSession', { hostKey: 'letmein', capMode: 'auctioning' })
await call(host, 'host:updateSettings', { penaltyRate: 20, auctionCapRatio: 1 })

// add bots
await call(host, 'host:addBots', { botType: 'compliance', count: 2 })
await call(host, 'host:addBots', { botType: 'marketMaker', count: 1 })
await call(host, 'host:addBots', { botType: 'speculator', count: 1 })
await call(host, 'host:addBots', { botType: 'noise', count: 2 })
await wait(50)
const bots = hs.players.filter((p) => p.isBot)
ok(bots.length === 6, `6 bots added (got ${bots.length}); all isBot=${bots.every((b) => b.isBot)}`)

// 1 human
const human = io(URL)
await new Promise((r) => human.on('connect', r))
let ph = null
human.on('session:snapshot', (x) => { if (x.role === 'player') ph = x })
await call(human, 'player:join', { roomCode, name: 'Alice', industry: 'Power & Utilities' })

// ===== CAP =====
await call(host, 'host:startYear')
await wait(6000) // ~2 bot ticks → auction bids
// Traders always bid; some emitters may rationally fully-abate and need no credits.
ok(hs.classAggregate.submittedCount >= 4, `auction bids submitted by bots: ${hs.classAggregate.submittedCount}/6 (rest fully abate)`)
await call(human, 'player:submitBid', { qty: 200, price: 12 })
await call(host, 'host:closeCapStage')
await wait(50)
// Read the ceiling from the running server rather than hardcoding it — these scripts
// silently went stale when penaltyRate moved from 20 to 100.
const P = hs.config.penaltyRate
ok(hs.auctionPrice !== null, `auction cleared at ${hs.auctionPrice}`)
ok(hs.regulatorPool > 0, `regulatorPool (supply) = ${hs.regulatorPool}`)
const traderGrant = hs.players.filter((p) => p.botType === 'marketMaker' || p.botType === 'speculator')
console.log('  trader awards:', traderGrant.map((p) => `${p.botType}=${p.regulatorGranted}`).join(' '))

// ===== TRADE =====
await call(host, 'host:openTrade')
await wait(24000) // ~9-10 bot ticks
const mv = hs.market
const prices = mv.trades.map((t) => t.price)
ok(mv.trades.length > 0, `trades happened: ${mv.trades.length}`)
ok(prices.every((p) => p > 0 && p <= P), `all trade prices in (0, ${P}]  [min ${Math.min(...prices)}, max ${Math.max(...prices)}]`)
ok(mv.vwap !== null && mv.vwap > 0 && mv.vwap <= P, `vwap bounded near fundamentals: ${mv.vwap}`)

// human can trade: post a marketable bid at the ceiling; a bot fills it within a tick
await call(human, 'player:placeOrder', { side: 'buy', qty: 15, price: P })
await wait(3500) // > 1 bot tick — MM/compliance either quotes an ask or lifts the human's bid
ok((ph.you.myTrades?.length ?? 0) > 0, `human found a counterparty: ${ph.you.myTrades?.length ?? 0} trades`)

await call(host, 'host:closeTrade')
await wait(50)
ok(hs.leaderboard.length === 7, `leaderboard has all participants: ${hs.leaderboard.length}`)
const mmRow = hs.leaderboard.find((r) => r.botType === 'marketMaker')
console.log('  MM leaderboard row (raw P&L):', mmRow?.normalizedScore)

// ===== END GAME =====
await call(host, 'host:endGame')
await wait(50)
const allFinite = hs.players.every((p) => Number.isFinite(p.score))
ok(allFinite, 'all scores finite after endGame monetization')
const mmFinal = hs.players.find((p) => p.botType === 'marketMaker')
console.log(`  MM final score after inventory monetized: ${mmFinal?.score} (negative = profit)`)

console.log(fails === 0 ? '\n✅ ALL BOT CHECKS PASSED' : `\n❌ ${fails} check(s) failed`)
host.close(); human.close()
process.exit(fails === 0 ? 0 : 1)

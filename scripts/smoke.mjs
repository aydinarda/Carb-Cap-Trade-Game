// Wire-protocol smoke test: host + 2 players walk a full year with the
// regulator sale, the order-book market, penalty settlement, a mode switch
// between years, and a token reconnect.
import { io } from 'socket.io-client'

const URL = 'http://localhost:3001'
const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve))
const connect = (auth = {}) => io(URL, { auth, transports: ['websocket'] })
const waitSnapshot = (socket) =>
  new Promise((resolve) => socket.once('session:snapshot', resolve))

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('ok:', msg)
}

const host = connect()
const created = await emit(host, 'host:createSession', { hostKey: 'letmein', capMode: 'grandfathering', seed: 42 })
assert(created.ok, `session created ${created.roomCode}`)
const { roomCode } = created

// settings can be changed in the lobby
const setSettings = await emit(host, 'host:updateSettings', { lowPenaltyRate: 1, highPenaltyRate: 3, regulatorPrice: 12 })
assert(setSettings.ok, 'settings updated in lobby')

// players pick their own industries
const p1 = connect()
const j1 = await emit(p1, 'player:join', { roomCode, name: 'Alice', industry: 'Transport' })
assert(j1.ok && j1.playerId === 'P1' && j1.profile.industry === 'Transport', 'P1 joined as Transport')
const p2 = connect()
const j2 = await emit(p2, 'player:join', { roomCode, name: 'Bob', industry: 'Power & Utilities' })
assert(j2.ok && j2.profile.industry === 'Power & Utilities', 'P2 joined as Power & Utilities')
const badJoin = await emit(connect(), 'player:join', { roomCode, name: 'X', industry: 'Nope' })
assert(!badJoin.ok, 'invalid industry rejected')

const started = await emit(host, 'host:startYear', {})
assert(started.ok, 'year 11 started')

let snap1 = await waitSnapshot(p1)
assert(snap1.phase === 'cap' && snap1.regulatorPool > 0, `regulator pool = ${snap1.regulatorPool}`)
// pool should be 20% of baseline: freeCreditLimit is 80% → pool = limit/4
assert(Math.abs(snap1.regulatorPool - snap1.freeCreditLimit / 4) < 0.5, 'pool ≈ baseline × 20%')

// oversubscribe the pool to force pro-rata
const bigAsk = Math.round(snap1.regulatorPool * 1.5)
assert((await emit(p1, 'player:requestCredits', { qty: bigAsk })).ok, `P1 requests ${bigAsk}`)
assert((await emit(p2, 'player:requestCredits', { qty: bigAsk })).ok, `P2 requests ${bigAsk}`)

assert((await emit(host, 'host:closeCapStage', {})).ok, 'cap stage closed')
snap1 = await waitSnapshot(p1)
assert(snap1.phase === 'reveal', 'reveal phase')
assert(snap1.you.regulatorGranted < bigAsk, `pro-rata: granted ${snap1.you.regulatorGranted} < requested ${bigAsk}`)
assert(Math.abs(snap1.you.regulatorGranted - snap1.regulatorPool / 2) < 0.2, 'granted = half the pool each')
assert(snap1.you.realized !== null && snap1.you.creditsHeld !== null, `realized=${snap1.you.realized} held=${snap1.you.creditsHeld}`)

// market
assert((await emit(host, 'host:openTrade', {})).ok, 'market opened')
const sell = await emit(p1, 'player:placeOrder', { side: 'sell', qty: 10, price: 15 })
assert(sell.ok, 'P1 posted ask 10 @ 15')
const oversell = await emit(p1, 'player:placeOrder', { side: 'sell', qty: 99999, price: 15 })
assert(!oversell.ok, `oversell rejected: "${oversell.error}"`)
const buy = await emit(p2, 'player:placeOrder', { side: 'buy', qty: 4, price: 16 })
assert(buy.ok, 'P2 posted crossing bid 4 @ 16')
let snap2 = await waitSnapshot(p2)
assert(snap2.market.trades.length === 1 && snap2.market.trades[0].price === 15, 'trade executed @ resting price 15')
assert(snap2.market.asks[0].remaining === 6, 'P1 ask partially filled (6 left)')
assert(snap2.you.myTrades.length === 1, 'P2 sees own trade')
const heldBefore = snap2.you.creditsHeld

// leave the 6 cr resting so settlement has a leftover pool
assert((await emit(host, 'host:closeTrade', {})).ok, 'market closed & settled')
snap2 = await waitSnapshot(p2)
assert(snap2.phase === 'yearSummary', 'year summary')
assert(snap2.you.creditsHeld === heldBefore, 'holdings unchanged by settlement')
assert(snap2.you.settlement !== null, `P2 settlement: ${JSON.stringify(snap2.you.settlement)}`)
const s = snap2.you.settlement
if (s.shortage > 0) {
  const expected = Math.round((s.coveredByLeftover * 1 + (s.shortage - s.coveredByLeftover) * 3) * 10) / 10
  assert(Math.abs(s.penalty - expected) < 0.11, `penalty ${s.penalty} = covered×1 + uncovered×3 (${expected})`)
}
assert(Array.isArray(snap2.leaderboard) && snap2.leaderboard.length === 2, 'leaderboard visible at year summary')

// mode switch between years
const modeSwitch = await emit(host, 'host:setCapMode', { mode: 'benchmarking' })
assert(modeSwitch.ok, 'mode switched to benchmarking at yearSummary')
const advFail = await emit(host, 'host:advanceYear', {})
assert(!advFail.ok && /pending/.test(advFail.error), 'advancing under benchmarking blocked (pending)')
assert((await emit(host, 'host:setCapMode', { mode: 'grandfathering' })).ok, 'switched back to grandfathering')
assert((await emit(host, 'host:advanceYear', {})).ok, 'advanced to year 12')
snap2 = await waitSnapshot(p2)
assert(snap2.currentYear === 12 && snap2.phase === 'cap', 'year 12 cap phase')
// mid-year settings change must be rejected
const lateSettings = await emit(host, 'host:updateSettings', { lowPenaltyRate: 9 })
assert(!lateSettings.ok, 'settings rejected mid-year (cap phase)')

// reconnect with token restores identity + cumulative penalties
p2.disconnect()
const p2b = connect({ role: 'player', token: j2.token })
const resumed = await waitSnapshot(p2b)
assert(resumed.you.id === 'P2' && resumed.currentYear === 12, 'P2 reconnected via token')
assert(typeof resumed.you.penaltyPoints === 'number', `penalty points persist: ${resumed.you.penaltyPoints}`)

console.log('\nALL SMOKE TESTS PASSED')
process.exit(0)

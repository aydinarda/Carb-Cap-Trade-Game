import { describe, expect, it } from 'vitest'
import { expectedEmission, round1, tradedNet } from '../../shared/engine'
import type { PlayerHistoryYear } from '../../shared/types'
import { Session } from '../session'
import { buildPlayerHistory, hostSnapshot, playerSnapshot } from '../views'

// leaderboard() and classAggregate() are internal to views.ts; exercise them
// through hostSnapshot(), which embeds both.

function runFullYear(s: Session) {
  s.startYear()
  s.closeCapStage()
  s.openTrade()
  s.closeTrade() // → yearSummary
}

describe('leaderboard normalization', () => {
  it('ranks emitters by skill and pushes pure-trader bots to the end with raw P&L', () => {
    const s = new Session('auctioning', 1)
    s.addPlayer('Alice', 'Power & Utilities') // P1 emitter
    s.addPlayer('Bob', 'Transport') // P2 emitter
    s.addBot('compliance') // P3 emitter bot
    s.addBot('marketMaker') // P4 pure trader
    runFullYear(s)

    const board = hostSnapshot(s).leaderboard
    expect(board).toHaveLength(4)

    // Pure-trader bots (marketMaker/speculator) sit at the end…
    const last = board[board.length - 1]
    expect(last.botType).toBe('marketMaker')
    // …and are scored by raw cumulative P&L, not the skill metric.
    expect(last.normalizedScore).toBe(round1(s.getPlayer(last.id)!.score))

    // Everyone before the trailing trader block is an emitter (not a pure trader).
    const traderTypes = new Set(['marketMaker', 'speculator'])
    const firstTraderIdx = board.findIndex((r) => r.botType && traderTypes.has(r.botType))
    expect(firstTraderIdx).toBe(3) // only the last row is a trader
    for (let i = 0; i < firstTraderIdx; i++) {
      expect(traderTypes.has(board[i].botType ?? '')).toBe(false)
    }
  })
})

describe('classAggregate', () => {
  it('reports auction demand only under auctioning and nulls before realization', () => {
    const s = new Session('auctioning', 1)
    s.addPlayer('Alice', 'Power & Utilities')
    s.addPlayer('Bob', 'Transport')
    s.startYear()
    s.submitBid('P1', 100, 15)

    const before = hostSnapshot(s).classAggregate
    expect(before.submittedCount).toBe(1)
    expect(before.totalRegulatorRequests).toBe(100) // sum of bid quantities
    expect(before.totalRealized).toBe(null) // not realized yet

    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    const after = hostSnapshot(s).classAggregate
    expect(after.totalRealized).toBeGreaterThan(0)
    expect(after.totalCostThisYear).not.toBe(null)
  })

  it('has no auction demand under grandfathering', () => {
    const s = new Session('grandfathering', 1)
    s.addPlayer('Alice', 'Power & Utilities')
    s.addPlayer('Bob', 'Transport')
    s.startYear()
    const agg = hostSnapshot(s).classAggregate
    expect(agg.submittedCount).toBe(0)
    expect(agg.totalRegulatorRequests).toBe(null)
  })

  it('reports the cap actually in force each year, so a tightening benchmark falls', () => {
    const s = new Session('benchmarking', 1)
    s.addPlayer('Alice', 'Power & Utilities')
    s.addPlayer('Bob', 'Transport')
    s.updateSettings({ capReductionFactor: 0.9 })
    runFullYear(s)
    s.advanceYear()
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()

    const { yearHistory } = hostSnapshot(s).classAggregate
    expect(yearHistory).toHaveLength(2)
    // The chart's cap line must track the allocation, not the once-computed limit.
    expect(yearHistory[1].cap).toBe(round1(yearHistory[0].cap * 0.9))
  })
})

/**
 * The original, deliberately naive implementation: one full rescan of each year's tape per
 * player, and no memo. Kept here as the oracle — `buildPlayerHistory` was rewritten to be
 * one pass per year plus a cache of completed years, and that must not have moved a number.
 */
function naivePlayerHistory(session: Session): Record<string, PlayerHistoryYear[]> {
  const { state } = session
  const years = Object.values(state.years).sort((a, b) => a.year - b.year)
  const history: Record<string, PlayerHistoryYear[]> = {}
  for (const p of state.players) {
    history[p.id] = years.map((y) => {
      const free = round1(y.freeAllocation[p.id] ?? 0)
      const granted = round1(y.regulatorGranted[p.id] ?? 0)
      const carriedIn = round1(y.carriedIn[p.id] ?? 0)
      const traded = tradedNet(y.trades, p.id)
      return {
        year: y.year,
        expected: round1(expectedEmission(p, y.year)),
        realized: y.realized[p.id] ?? null,
        free,
        regulatorGranted: granted,
        traded,
        abatement: round1(y.abatement[p.id] ?? 0),
        banked: carriedIn,
        creditsHeld: round1(free + granted + carriedIn + traded),
        netPosition: y.netPosition[p.id] ?? null,
        settlement: y.settlement?.[p.id] ?? null,
      }
    })
  }
  return history
}

describe('buildPlayerHistory', () => {
  /** `advanceYear` already leaves the session in `cap`, so only year 11 opens with startYear. */
  function tradedYear(s: Session, first = false) {
    if (first) s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.placeOrder('P1', 'sell', 12, 50)
    s.placeOrder('P2', 'buy', 12, 50)
    s.placeOrder('P3', 'buy', 7, 55)
    s.placeOrder('P1', 'sell', 7, 55)
    s.closeTrade()
  }

  function seeded() {
    const s = new Session('grandfathering', 7)
    s.addPlayer('Alice', 'Power & Utilities') // P1
    s.addPlayer('Bob', 'Transport') // P2
    s.addPlayer('Cara', 'Heavy Materials') // P3
    return s
  }

  it('matches the naive implementation across three played years', () => {
    const s = seeded()
    for (let i = 0; i < 3; i++) {
      tradedYear(s, i === 0)
      expect(buildPlayerHistory(s)).toEqual(naivePlayerHistory(s))
      if (i < 2) s.advanceYear()
    }
  })

  it('returns the same answer on a second call, once years are memoized', () => {
    const s = seeded()
    tradedYear(s, true)
    s.advanceYear()
    tradedYear(s)
    // The first call fills the memo for the now-completed year 11; the second reads it.
    const first = buildPlayerHistory(s)
    const second = buildPlayerHistory(s)
    expect(second).toEqual(first)
    expect(second).toEqual(naivePlayerHistory(s))
  })

  it('does not serve a cached year that predates a roster change', () => {
    const s = seeded()
    tradedYear(s, true)
    s.advanceYear()
    tradedYear(s)
    buildPlayerHistory(s) // memoizes year 11 for P1..P3

    // The roster is locked at startYear today — addPlayer and kickPlayer are both
    // lobby-only — so this reaches into state directly. It guards the memo against a
    // future mechanism that lets someone join mid-game: a year cached before they
    // existed must not be handed back missing their row.
    s.state.players.push({ ...s.state.players[0], id: 'PX', name: 'Late' })

    const after = buildPlayerHistory(s)
    expect(Object.keys(after).sort()).toEqual(['P1', 'P2', 'P3', 'PX'])
    expect(after.PX).toHaveLength(2)
    expect(after).toEqual(naivePlayerHistory(s))
  })
})

describe('benchmarking player snapshot', () => {
  it('carries the sector benchmark and the average it is set below', () => {
    const s = new Session('benchmarking', 1)
    s.addPlayer('Alice', 'Power & Utilities')
    s.startYear()
    const snap = playerSnapshot(s, 'P1')
    expect(snap.sectorAverage).toBe(1000) // midpoint of 850..1150
    expect(snap.sectorBenchmark).toBe(600) // 40% below it
    expect(snap.you.freeAllocation).toBe(600)
    expect(snap.auctionSupply).toBe(0)
  })

  it('leaves both null outside benchmarking', () => {
    const s = new Session('grandfathering', 1)
    s.addPlayer('Alice', 'Power & Utilities')
    s.startYear()
    const snap = playerSnapshot(s, 'P1')
    expect(snap.sectorBenchmark).toBe(null)
    expect(snap.sectorAverage).toBe(null)
  })
})

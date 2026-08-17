import { describe, expect, it } from 'vitest'
import { round1 } from '../../shared/engine'
import { Session } from '../session'
import { hostSnapshot } from '../views'

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
})

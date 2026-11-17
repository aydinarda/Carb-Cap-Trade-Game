import { describe, expect, it } from 'vitest'
import { flushDelay } from '../broadcaster'
import { Session } from '../session'
import { playerSnapshot, sharedPlayerView } from '../views'

/**
 * A flush builds the class-wide parts of the player snapshots once (2026-11-17). That is only an
 * optimisation if every player still gets exactly what it would get on its own.
 */
describe('a flush shares the class-wide parts of the player snapshots', () => {
  it('gives every player exactly the snapshot it would get on its own, in every phase', () => {
    const s = new Session('hybrid', 3)
    const a = s.addPlayer('A', 'Power & Utilities').player
    const b = s.addPlayer('B', 'Transport').player
    s.addBot('compliance')
    s.addBot('marketMaker')
    const same = () => {
      const shared = sharedPlayerView(s)
      for (const p of [a, b]) expect(playerSnapshot(s, p.id, shared)).toEqual(playerSnapshot(s, p.id))
    }
    same() // lobby
    s.startYear()
    same() // cap
    s.closeCapStage()
    s.openTrade()
    s.placeOrder(a.id, 'buy', 5, 40)
    same() // trade, with a book
    s.closeTrade()
    same() // year summary, with a leaderboard
    s.endGame()
    same()
  })
})

describe('flushDelay', () => {
  it('grows with the room, from FLUSH_MS up to its ceiling', () => {
    expect(flushDelay(0)).toBe(100)
    expect(flushDelay(10)).toBe(100)
    expect(flushDelay(50)).toBe(250)
    expect(flushDelay(100)).toBe(500)
    expect(flushDelay(1000)).toBe(1000)
  })
})

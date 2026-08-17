import { describe, expect, it } from 'vitest'
import { FIRST_GAME_YEAR, MAX_PLAYERS } from '../../shared/constants'
import { clearAuction, round1 } from '../../shared/engine'
import { GameError, Session } from '../session'

// Session is fully drivable without sockets; a numeric seed makes emission
// realization deterministic. Tests assert invariants (computed from state) rather
// than seed-dependent magic numbers.

function grandfathering(seed = 1) {
  const s = new Session('grandfathering', seed)
  s.addPlayer('Alice', 'Power & Utilities')
  s.addPlayer('Bob', 'Transport')
  return s
}

function auctioning(seed = 1) {
  const s = new Session('auctioning', seed)
  s.addPlayer('Alice', 'Power & Utilities')
  s.addPlayer('Bob', 'Transport')
  return s
}

describe('EU-ETS banking & make-good debt carry', () => {
  it('carries the year-end net position: surplus banked, shortfall as debt', () => {
    const s = grandfathering()
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 1) // full abatement → realized ~0 → banks all its free credits
    s.setAbatement('P2', 0) // no abatement → realized > free (80%) → short → debt
    s.closeTrade()
    const rec = s.currentYearRecord()!

    // Invariant: bankedCredits == held − realized for every player.
    for (const p of s.state.players) {
      expect(p.bankedCredits).toBe(round1(s.creditsHeld(p.id) - rec.realized[p.id]))
    }
    // P1 fully abated → realized 0, banks positive.
    expect(rec.realized.P1).toBe(0)
    expect(s.getPlayer('P1')!.bankedCredits).toBeGreaterThan(0)
    // Any short player pays the penalty AND carries a negative (debt) — both, not one.
    for (const p of s.state.players) {
      if (rec.realized[p.id] > s.creditsHeld(p.id)) {
        expect(rec.settlement![p.id].penaltyCost).toBeGreaterThan(0)
        expect(p.bankedCredits).toBeLessThan(0)
      }
    }
  })

  it('carries the banked balance into next year as carriedIn and into creditsHeld', () => {
    const s = grandfathering()
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 1)
    s.closeTrade()
    const banked = s.getPlayer('P1')!.bankedCredits
    expect(banked).toBeGreaterThan(0)
    s.advanceYear()
    const rec2 = s.currentYearRecord()!
    expect(rec2.carriedIn.P1).toBe(banked)
    // creditsHeld includes the carried-in balance (free + granted + carriedIn + traded).
    expect(s.creditsHeld('P1')).toBe(round1((rec2.freeAllocation.P1 ?? 0) + banked))
  })
})

describe('endGame — monetize leftover carry at the final price', () => {
  it('banks/debts are cashed at the final price and reset; phase ends', () => {
    const s = grandfathering()
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 1)
    s.closeTrade()
    // No trades occurred and grandfathering has no auction price → final price = penaltyRate.
    const finalPrice = s.state.config.penaltyRate
    const before = new Map(s.state.players.map((p) => [p.id, { score: p.score, banked: p.bankedCredits }]))
    s.endGame()
    expect(s.state.phase).toBe('ended')
    for (const p of s.state.players) {
      const b = before.get(p.id)!
      expect(p.score).toBe(round1(b.score - b.banked * finalPrice))
      expect(p.bankedCredits).toBe(0)
    }
  })
})

describe('capReductionFactor (EU-ETS LRF)', () => {
  it('shrinks the auction supply geometrically each year', () => {
    const s = auctioning()
    s.updateSettings({ auctionCapRatio: 1, capReductionFactor: 0.9 })
    s.startYear()
    const baseline = s.state.players.reduce((a, p) => a + (p.emissions[10] ?? 0), 0)
    const pool11 = s.currentYearRecord()!.regulatorPool
    expect(pool11).toBe(round1(baseline)) // year 1: exponent 0, factor^0 = 1

    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    s.advanceYear() // year 12
    const pool12 = s.currentYearRecord()!.regulatorPool
    expect(pool12).toBe(round1(baseline * 0.9)) // factor^(12−11)
    expect(pool12).toBeLessThan(pool11)
  })

  it('is zero under grandfathering (no auction supply)', () => {
    const s = grandfathering()
    s.startYear()
    expect(s.currentYearRecord()!.regulatorPool).toBe(0)
  })
})

describe('closeTrade cost-ledger wiring (auctioning)', () => {
  it('purchaseCost = award × clearing price when there are no market trades', () => {
    const s = auctioning()
    s.startYear()
    s.submitBid('P1', 100, 15)
    s.closeCapStage()
    const rec = s.currentYearRecord()!
    const award = rec.regulatorGranted.P1 ?? 0
    const clearing = rec.auctionPrice!
    expect(award).toBeGreaterThan(0)
    s.openTrade()
    s.closeTrade()
    expect(rec.settlement!.P1.purchaseCost).toBe(round1(award * clearing))
    expect(rec.settlement!.P1.sellIncome).toBe(0)
    // Cumulative score advanced by this year's cost.
    expect(s.getPlayer('P1')!.score).toBe(rec.settlement!.P1.yearCost)
  })
})

describe('no-shorting enforcement (placeOrder sell)', () => {
  it('rejects selling more than held minus open asks', () => {
    const s = grandfathering()
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    const cap = s.creditsHeld('P1')
    expect(cap).toBeGreaterThan(0)
    expect(() => s.placeOrder('P1', 'sell', round1(cap + 1), 10)).toThrow(GameError)
    // Selling exactly the capacity rests (no crossing bid present).
    s.placeOrder('P1', 'sell', cap, 10)
    // The open ask now consumes all capacity → a further sell is rejected.
    expect(() => s.placeOrder('P1', 'sell', 1, 10)).toThrow(/no shorting|at most/i)
  })
})

describe('closeCapStage auction wiring', () => {
  it('produces the same clearing/awards as a direct clearAuction call; phase → reveal', () => {
    const s = auctioning()
    s.startYear()
    s.submitBid('P1', 100, 15)
    s.submitBid('P2', 50, 12)
    const rec = s.currentYearRecord()!
    const expected = clearAuction(rec.auctionBid, rec.regulatorPool)
    s.closeCapStage()
    expect(rec.auctionPrice).toBe(expected.clearingPrice)
    expect(rec.regulatorGranted).toEqual(expected.awarded)
    expect(s.state.phase).toBe('reveal')
  })

  it('leaves grandfathering untouched (no grant / no auction price)', () => {
    const s = grandfathering()
    s.startYear()
    s.closeCapStage()
    const rec = s.currentYearRecord()!
    expect(rec.auctionPrice).toBe(null)
    expect(Object.keys(rec.regulatorGranted)).toHaveLength(0)
    expect(s.state.phase).toBe('reveal')
  })
})

describe('updateSettings validation & precision', () => {
  it('stores capReductionFactor at fine precision (0.97 must not round to 1.0)', () => {
    const s = auctioning()
    s.updateSettings({ capReductionFactor: 0.97 })
    expect(s.state.config.capReductionFactor).toBe(0.97)
  })

  it('rejects out-of-range / negative settings', () => {
    const s = auctioning()
    expect(() => s.updateSettings({ capReductionFactor: 0 })).toThrow(GameError)
    expect(() => s.updateSettings({ capReductionFactor: 1.5 })).toThrow(GameError)
    expect(() => s.updateSettings({ penaltyRate: -1 })).toThrow(GameError)
    expect(() => s.updateSettings({ auctionCapRatio: -0.5 })).toThrow(GameError)
  })

  it('is blocked mid-year (only lobby / yearSummary)', () => {
    const s = auctioning()
    s.startYear() // phase 'cap'
    expect(() => s.updateSettings({ penaltyRate: 5 })).toThrow(/phase/i)
  })
})

describe('creditsHeld composition & previousMarketPrice', () => {
  it('creditsHeld = free + granted + carriedIn + tradedNet', () => {
    const s = auctioning()
    s.startYear()
    s.submitBid('P1', 100, 15)
    s.closeCapStage()
    const rec = s.currentYearRecord()!
    // Auctioning: no free credits; year 1 no carry; no trades yet → held == award.
    expect(s.creditsHeld('P1')).toBe(round1(rec.regulatorGranted.P1 ?? 0))
  })

  it('previousMarketPrice is null in year 1, then the prior year (auction price fallback)', () => {
    const s = auctioning()
    s.startYear()
    s.submitBid('P1', 100, 15)
    expect(s.previousMarketPrice()).toBe(null) // no completed year yet
    s.closeCapStage()
    const auctionPrice = s.currentYearRecord()!.auctionPrice
    s.openTrade()
    s.closeTrade()
    s.advanceYear() // year 12 — year 11 now settled, no market trades → VWAP falls back to auction price
    expect(s.previousMarketPrice()).toBe(auctionPrice)
  })
})

describe('lobby management', () => {
  it('renumbers ids P1..PN and remaps tokens after a mid-lobby kick', () => {
    const s = new Session('grandfathering', 1)
    const { token: tA } = s.addPlayer('A', 'Power & Utilities') // P1
    const { token: tB } = s.addPlayer('B', 'Transport') // P2
    const { token: tC } = s.addPlayer('C', 'Transport') // P3
    s.kickPlayer('P2')
    expect(s.state.players.map((p) => p.id)).toEqual(['P1', 'P2'])
    expect(s.playerTokens.get(tA)).toBe('P1') // A unchanged
    expect(s.playerTokens.get(tC)).toBe('P2') // C renumbered P3 → P2
    expect(s.playerTokens.get(tB)).toBeUndefined() // B's token removed
  })

  it('addBot flags a bot; removeBot only removes bots', () => {
    const s = new Session('auctioning', 1)
    s.addPlayer('Human', 'Transport') // P1
    const bot = s.addBot('compliance') // P2
    expect(bot.isBot).toBe(true)
    expect(bot.botType).toBe('compliance')
    expect(() => s.removeBot('P1')).toThrow(/bot/i) // P1 is human
    s.removeBot(bot.id)
    expect(s.state.players.map((p) => p.id)).toEqual(['P1'])
  })

  it('enforces the MAX_PLAYERS cap', () => {
    const s = new Session('grandfathering', 1)
    for (let i = 0; i < MAX_PLAYERS; i++) s.addPlayer(`P${i}`, 'Transport')
    expect(() => s.addPlayer('overflow', 'Transport')).toThrow(GameError)
    expect(s.state.players).toHaveLength(MAX_PLAYERS)
  })

  it('only allows startYear from the lobby with players', () => {
    const empty = new Session('grandfathering', 1)
    expect(() => empty.startYear()).toThrow(/no players/i)
    void FIRST_GAME_YEAR
  })
})

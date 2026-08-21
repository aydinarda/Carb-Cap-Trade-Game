import { describe, expect, it } from 'vitest'
import { DEFAULT_GAME_CONFIG } from '../../shared/config'

const FIRST_GAME_YEAR = DEFAULT_GAME_CONFIG.emissions.firstGameYear
import { clearAuction, round1 } from '../../shared/engine'
import { GameError, Session, SessionStore } from '../session'

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
    const finalPrice = s.state.config.market.penaltyRate
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
    expect(s.state.config.allocation.capReductionFactor).toBe(0.97)
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

  it('is uncapped by default — a room takes as many players as you throw at it', () => {
    const s = new Session('grandfathering', 1)
    expect(s.state.config.session.maxPlayers).toBe(0)
    for (let i = 0; i < 120; i++) s.addPlayer(`P${i}`, 'Transport')
    expect(s.state.players).toHaveLength(120)
  })

  it('honours an explicit cap, and bots consume the same quota', () => {
    const s = new Session('grandfathering', 1, { session: { maxPlayers: 5 } })
    for (let i = 0; i < 3; i++) s.addPlayer(`P${i}`, 'Transport')
    s.addBot('compliance')
    s.addBot('noise')
    // Five seats taken — three humans and two bots — so the sixth is refused.
    expect(() => s.addPlayer('overflow', 'Transport')).toThrow(/full/i)
    expect(() => s.addBot('noise')).toThrow(/full/i)
    expect(s.state.players).toHaveLength(5)
  })

  it('only allows startYear from the lobby with players', () => {
    const empty = new Session('grandfathering', 1)
    expect(() => empty.startYear()).toThrow(/no players/i)
    void FIRST_GAME_YEAR
  })
})

describe('benchmarking mode', () => {
  function benchmarking(seed = 1) {
    const s = new Session('benchmarking', seed)
    s.addPlayer('Alice', 'Power & Utilities')
    s.addPlayer('Bob', 'Transport')
    return s
  }

  it('issues the sector benchmark and no primary supply', () => {
    const s = benchmarking()
    s.startYear()
    const rec = s.currentYearRecord()!
    const { benchmark } = s.state.config.allocation
    expect(rec.freeAllocation.P1).toBe(benchmark['Power & Utilities'])
    expect(rec.freeAllocation.P2).toBe(benchmark.Transport)
    expect(rec.regulatorPool).toBe(0)
  })

  it('tightens the allocation each year by capReductionFactor', () => {
    const s = benchmarking()
    s.updateSettings({ capReductionFactor: 0.9 })
    s.startYear()
    const year11 = s.currentYearRecord()!.freeAllocation.P1
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    s.advanceYear()
    const year12 = s.currentYearRecord()!.freeAllocation.P1
    expect(year12).toBe(round1(year11 * 0.9))
  })

  it('rejects cap-stage bids — there is no auction to bid into', () => {
    const s = benchmarking()
    s.startYear()
    expect(() => s.submitBid('P1', 10, 5)).toThrow(/no cap-stage auction/i)
  })

  it('circulatingCap is the free allocation, and the auction pool under auctioning', () => {
    const b = benchmarking()
    b.startYear()
    const rec = b.currentYearRecord()!
    const totalFree = Object.values(rec.freeAllocation).reduce((x, y) => x + y, 0)
    expect(b.circulatingCap()).toBe(round1(totalFree))

    // No-regression guard for the market maker's target inventory.
    const a = auctioning()
    a.startYear()
    expect(a.circulatingCap()).toBe(a.currentYearRecord()!.regulatorPool)
  })
})

describe('trader-bot seed inventory', () => {
  it('sells pure-trader bots an opening book at the reference price, once', () => {
    const s = new Session('benchmarking', 1)
    s.addPlayer('Human', 'Power & Utilities') // P1
    const mm = s.addBot('marketMaker') // P2
    const firm = s.addBot('compliance') // P3
    s.startYear()
    const rec = s.currentYearRecord()!

    // Year 1 has no discovered price yet, so the seed is priced at penaltyRate / 2.
    expect(rec.primaryPrice).toBe(s.state.config.market.penaltyRate / 2)
    // The MM gets no free allocation but a seed it must pay for…
    expect(rec.freeAllocation[mm.id]).toBe(0)
    expect(rec.regulatorGranted[mm.id]).toBeGreaterThan(0)
    // …while a real emitter gets its benchmark and no seed.
    expect(rec.freeAllocation[firm.id]).toBeGreaterThan(0)
    expect(rec.regulatorGranted[firm.id]).toBeUndefined()

    // The seed is charged through the normal cap-cost line.
    const seed = rec.regulatorGranted[mm.id]
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    expect(rec.settlement![mm.id].purchaseCost).toBe(round1(seed * rec.primaryPrice!))

    // Only in the first game year — afterwards it carries inventory via banking.
    s.advanceYear()
    expect(s.currentYearRecord()!.regulatorGranted[mm.id]).toBeUndefined()
  })

  it('grants no seed under auctioning — bots fund themselves at the clearing price', () => {
    const s = new Session('auctioning', 1)
    s.addPlayer('Human', 'Power & Utilities')
    const mm = s.addBot('marketMaker')
    s.startYear()
    const rec = s.currentYearRecord()!
    expect(rec.regulatorGranted[mm.id]).toBeUndefined()
    expect(rec.primaryPrice).toBe(0) // no auction price until the cap stage closes
  })
})

describe('the optimum benchmark sees the carry', () => {
  it('a debtor is not measured as though it still had the allowances it owes', () => {
    // Year 11: no abatement, no trades -> P2 ends short and carries a make-good debt.
    const s = grandfathering()
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    const debt = s.getPlayer('P2')!.bankedCredits
    expect(debt).toBeLessThan(0)

    const optimalAfterY11 = s.getPlayer('P2')!.optimalScore
    s.advanceYear()
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    const y12Optimum = s.getPlayer('P2')!.optimalScore - optimalAfterY11

    // Same year with the debt cleared: the benchmark must be strictly cheaper, because
    // perfect play then starts with more allowances in hand.
    const clean = grandfathering()
    clean.startYear()
    clean.closeCapStage()
    clean.openTrade()
    clean.closeTrade()
    clean.getPlayer('P2')!.bankedCredits = 0 // wipe the carry, change nothing else
    const optimalAfterY11Clean = clean.getPlayer('P2')!.optimalScore
    clean.advanceYear()
    clean.closeCapStage()
    clean.openTrade()
    clean.closeTrade()
    const y12OptimumClean = clean.getPlayer('P2')!.optimalScore - optimalAfterY11Clean

    // Carrying a debt raises the bar you are measured against, rather than leaving it
    // where a debt-free company's would be — which used to punish the debt a third time.
    expect(y12Optimum).toBeGreaterThan(y12OptimumClean)
  })
})

describe('SessionStore lifecycle', () => {
  const HOUR = 60 * 60_000

  it('only ticks rooms that are worth ticking', () => {
    const store = new SessionStore()
    const noBots = store.create('benchmarking', 1)
    noBots.addPlayer('Alice', 'Transport')

    const withBots = store.create('benchmarking', 1)
    withBots.addPlayer('Bob', 'Transport')
    withBots.addBot('compliance')

    const finished = store.create('benchmarking', 1)
    finished.addPlayer('Cara', 'Transport')
    finished.addBot('compliance')
    finished.endGame()

    // A room with no bots has nothing for the driver to do, and a finished one is over.
    expect(store.activeSessions().map((x) => x.state.roomCode)).toEqual([withBots.state.roomCode])
  })

  it('drops finished rooms once the grace window has passed, and not before', () => {
    const store = new SessionStore()
    const s = store.create('benchmarking', 1)
    s.addPlayer('Alice', 'Transport')
    s.endGame()
    const grace = s.state.config.session.endedGraceMs

    expect(store.sweep(Date.now() + grace - 1_000)).toEqual([])
    expect(store.get(s.state.roomCode)).toBeDefined()

    expect(store.sweep(Date.now() + grace + 1_000)).toEqual([s.state.roomCode])
    expect(store.get(s.state.roomCode)).toBeUndefined()
  })

  it('drops abandoned rooms but keeps one that still has somebody connected', () => {
    const store = new SessionStore()
    const abandoned = store.create('benchmarking', 1)
    const { player } = abandoned.addPlayer('Alice', 'Transport')
    player.connected = false

    const live = store.create('benchmarking', 1)
    live.addPlayer('Bob', 'Transport') // connected by default

    const later = Date.now() + 3 * HOUR
    expect(store.sweep(later)).toEqual([abandoned.state.roomCode])
    expect(store.get(live.state.roomCode)).toBeDefined()
  })

  it('a bot-only room counts as abandoned — bots do not keep a class alive', () => {
    const store = new SessionStore()
    const s = store.create('benchmarking', 1)
    s.addBot('compliance')
    expect(store.sweep(Date.now() + 3 * HOUR)).toEqual([s.state.roomCode])
  })

  it('touch() keeps a room alive past the idle window', () => {
    const store = new SessionStore()
    const s = store.create('benchmarking', 1)
    const { player } = s.addPlayer('Alice', 'Transport')
    player.connected = false

    const later = Date.now() + 3 * HOUR
    s.lastActivity = later // as if something happened just now
    expect(store.sweep(later)).toEqual([])
  })
})

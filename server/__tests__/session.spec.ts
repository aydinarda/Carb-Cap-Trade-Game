import { describe, expect, it } from 'vitest'
import { DEFAULT_GAME_CONFIG, type DeepPartial, type GameConfig } from '../../shared/config'

const FIRST_GAME_YEAR = DEFAULT_GAME_CONFIG.emissions.firstGameYear
import { clearAuction, round1 } from '../../shared/engine'
import { GameError, Session, SessionStore } from '../session'

// Session is fully drivable without sockets; a numeric seed makes emission
// realization deterministic. Tests assert invariants (computed from state) rather
// than seed-dependent magic numbers.

function grandfathering(seed = 1, override?: DeepPartial<GameConfig>) {
  const s = new Session('grandfathering', seed, override)
  s.addPlayer('Alice', 'Power & Utilities')
  s.addPlayer('Bob', 'Transport')
  return s
}

/**
 * A session where a company may cut everything, and the retrofit is free. The shipped cap
 * is `abatement.lifetimeCap` (a plant cannot switch itself off), but the banking tests
 * below are about what happens at the EXTREMES of the carry — a full surplus and a full
 * shortfall — and driving one player's realized emissions to ~0 is the cleanest way to get
 * there. The fee is zeroed so the carry arithmetic is not muddied by an investment charge.
 */
function unlimitedAbatement(seed = 1) {
  return grandfathering(seed, {
    abatement: { lifetimeCap: 1, fixedCostPerTonneBaseline: 0 },
  })
}

/**
 * Install capacity in the first year and play through to the second, where it is in force.
 *
 * Every test that wants a company's *realized* emissions cut has to be two years long now:
 * capacity installed during a year does nothing to that year. A one-year driver silently
 * tests nothing, which is exactly the failure mode this helper exists to prevent.
 */
function installAndAdvance(s: Session, levels: Record<string, number>) {
  s.startYear()
  s.closeCapStage()
  s.openTrade()
  for (const [id, level] of Object.entries(levels)) s.setAbatement(id, level)
  s.closeTrade()
  s.advanceYear()
  s.closeCapStage()
  s.openTrade()
}

function auctioning(seed = 1) {
  const s = new Session('auctioning', seed)
  s.addPlayer('Alice', 'Power & Utilities')
  s.addPlayer('Bob', 'Transport')
  return s
}

describe('EU-ETS banking & make-good debt carry', () => {
  it('carries the year-end net position: surplus banked, shortfall as debt', () => {
    const s = unlimitedAbatement()
    // Two years: P1's full cut is bought in year 1 and only bites in year 2.
    installAndAdvance(s, { P1: 1 }) // P2 never installs → short → debt
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
    const s = unlimitedAbatement()
    installAndAdvance(s, { P1: 1 })
    s.closeTrade()
    const banked = s.getPlayer('P1')!.bankedCredits
    expect(banked).toBeGreaterThan(0)
    s.advanceYear()
    const rec3 = s.currentYearRecord()!
    expect(rec3.carriedIn.P1).toBe(banked)
    // creditsHeld includes the carried-in balance (free + granted + carriedIn + traded).
    expect(s.creditsHeld('P1')).toBe(round1((rec3.freeAllocation.P1 ?? 0) + banked))
  })
})

describe('endGame — surplus is stranded, debt still settles', () => {
  /** Drives one year and returns the session plus everyone's pre-endGame position. */
  const playOneYear = (seed: number, config?: DeepPartial<GameConfig>) => {
    const s = grandfathering(seed, config)
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    const before = new Map(
      s.state.players.map((p) => [p.id, { score: p.score, banked: p.bankedCredits }]),
    )
    return { s, before }
  }

  it('leaves an unsold surplus worth nothing', () => {
    // Free allocation well above emissions, so everyone ends long and nobody sold.
    const { s, before } = playOneYear(1, { allocation: { freeCreditRatio: 3 } })
    const longPlayers = s.state.players.filter((p) => before.get(p.id)!.banked > 0)
    expect(longPlayers.length).toBeGreaterThan(0)
    s.endGame()
    for (const p of longPlayers) {
      // Cashing it out at the final price used to make hoarding riskless — and with no
      // trades the fallback price is the PENALTY, the dearest price in the game.
      expect(p.score, p.id).toBe(before.get(p.id)!.score)
    }
  })

  it('still charges a leftover make-good debt', () => {
    const { s, before } = playOneYear(1)
    const debtors = s.state.players.filter((p) => before.get(p.id)!.banked < 0)
    expect(debtors.length).toBeGreaterThan(0)
    const finalPrice = s.state.config.market.penaltyRate // no trades, no auction
    s.endGame()
    for (const p of debtors) {
      const b = before.get(p.id)!
      // An obligation does not expire because the game stopped: defaulting in the final
      // year must not be cheaper than defaulting in any other.
      expect(p.score, p.id).toBe(round1(b.score - b.banked * finalPrice))
    }
  })

  it('keeps the closing position on the books, and ends the game', () => {
    const { s, before } = playOneYear(1, { allocation: { freeCreditRatio: 3 } })
    s.endGame()
    expect(s.state.phase).toBe('ended')
    // Not zeroed — the final screen has to be able to show what was stranded or owed.
    for (const p of s.state.players) {
      if (before.get(p.id)!.banked > 0) expect(p.bankedCredits).toBe(before.get(p.id)!.banked)
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

describe('lifetime abatement budget', () => {
  const CAP = DEFAULT_GAME_CONFIG.abatement.lifetimeCap

  it('clamps a request above the budget instead of honouring it', () => {
    const s = grandfathering()
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 1)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(CAP)
    expect(s.abatementLifetimeCap).toBe(CAP)
  })

  it('leaves a request inside the budget untouched', () => {
    const s = grandfathering()
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 0.15)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.15)
  })

  it('binds under every cap mechanism, not just one', () => {
    for (const mode of ['grandfathering', 'benchmarking', 'auctioning'] as const) {
      const s = new Session(mode, 1)
      s.addPlayer('Alice', 'Power & Utilities')
      s.startYear()
      s.closeCapStage()
      s.openTrade()
      s.setAbatement('P1', 0.9)
      expect(s.getPlayer('P1')!.abatementCommitted, mode).toBe(CAP)
    }
  })

  it('is a LIFETIME budget: repeated installs cannot exceed it in total', () => {
    // The property the rename exists to protect. Under the old per-year ceiling, three
    // years at 0.45 each would have been legal.
    const s = grandfathering(1, { abatement: { lifetimeCap: 0.45 } })
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 0.3)
    s.closeTrade()
    s.advanceYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 1) // asks for everything; gets only the remaining headroom
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.45)
    s.closeTrade()
    // A company can therefore never cut below a floor: emissions stay strictly positive.
    expect(s.currentYearRecord()!.realized.P1).toBeGreaterThan(0)
  })

  it('is configurable, and lowering it mid-game binds future installs only', () => {
    const s = grandfathering(1, { abatement: { lifetimeCap: 0.45 } })
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 0.45)
    s.closeTrade()
    // The host tightens the budget below what P1 has already built and paid for.
    s.updateSettings({ abatementLifetimeCap: 0.2 })
    s.advanceYear()
    // Nothing is un-installed and nothing is refunded — the kit is in the ground.
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.45)
    expect(s.getPlayer('P1')!.abatementInForce).toBe(0.45)
    // But no further install is possible: the request is below what is committed.
    s.closeCapStage()
    s.openTrade()
    expect(() => s.setAbatement('P1', 0.3)).toThrow(GameError)
  })
})

describe('abatement as permanent installed capacity', () => {
  const FREE = { abatement: { fixedCostPerTonneBaseline: 0 } }

  it('takes effect from the NEXT year, never the year it is bought', () => {
    // The lag, proved by identity: a session that installs in year 11 must realize exactly
    // what a same-seed session that installed nothing does. Same seed, same draws.
    const invests = grandfathering(7)
    const idle = grandfathering(7)
    for (const s of [invests, idle]) {
      s.startYear()
      s.closeCapStage()
      s.openTrade()
    }
    invests.setAbatement('P1', 0.4)
    for (const s of [invests, idle]) s.closeTrade()
    expect(invests.currentYearRecord()!.realized.P1).toBe(
      idle.currentYearRecord()!.realized.P1,
    )
    // …and diverges the moment the next year opens.
    for (const s of [invests, idle]) {
      s.advanceYear()
      s.closeCapStage()
      s.openTrade()
      s.closeTrade()
    }
    const cut = invests.currentYearRecord()!.realized.P1
    const uncut = idle.currentYearRecord()!.realized.P1
    expect(cut).toBeLessThan(uncut)
    // 3 dp, not more: realizeYear rounds each draw to 0.1 t, so the ratio of two rounded
    // emissions carries a tick of slack that has nothing to do with the model.
    expect(cut / uncut).toBeCloseTo(0.6, 3)
  })

  it('holds its level instead of compounding, however long it stands', () => {
    // The failure this design exists to avoid: 20% re-applied each year is 0.8ⁿ, which is
    // 33% of baseline by year 15 and a dead market long before that.
    const s = grandfathering(5, { emissions: { volatility: 0 }, ...FREE })
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    const before = s.plannedEmission('P1')
    s.setAbatement('P1', 0.2)
    s.closeTrade()
    for (let y = 0; y < 4; y++) {
      s.advanceYear()
      s.closeCapStage()
      s.openTrade()
      s.closeTrade()
    }
    // Four years later, still 80% — within the per-year 0.1 t rounding, and nowhere near
    // the 0.8⁵ = 33% a compounding implementation would have produced.
    const held = s.currentYearRecord()!.realized.P1
    expect(Math.abs(held - before * 0.8)).toBeLessThan(0.5)
    expect(held).toBeGreaterThan(before * 0.7)
  })

  it('is charged once, in the year it is bought, and never again', () => {
    const s = grandfathering(2)
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 0.3)
    const spend = s.currentYearRecord()!.abatementSpend.P1
    expect(spend).toBeGreaterThan(0)
    s.closeTrade()
    expect(s.currentYearRecord()!.settlement!.P1.abatementCost).toBe(spend)
    // Year 2: the capacity is working and costs nothing more.
    s.advanceYear()
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    expect(s.currentYearRecord()!.abatementSpend.P1).toBeUndefined()
    expect(s.currentYearRecord()!.settlement!.P1.abatementCost).toBe(0)
  })

  it('is idempotent — a bot re-asserting its level every tick pays once', () => {
    // The highest-risk regression in this change: compliance.trade calls setAbatement on
    // EVERY tick, so without the equality short-circuit one bot pays a dozen fees a year.
    const s = grandfathering(2)
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 0.3)
    const once = s.currentYearRecord()!.abatementSpend.P1
    for (let i = 0; i < 20; i++) s.setAbatement('P1', 0.3)
    expect(s.currentYearRecord()!.abatementSpend.P1).toBe(once)
  })

  it('refuses to go down — a retrofit cannot be un-installed', () => {
    const s = grandfathering(2)
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    s.setAbatement('P1', 0.3)
    // Clamping instead of rejecting would look like a successful un-install, charge
    // nothing, and leave the client showing a level the company had already paid for.
    expect(() => s.setAbatement('P1', 0.1)).toThrow(/permanent/i)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.3)
  })

  it('charges exactly one extra fee for stepping, within a year and across years', () => {
    // The user's arithmetic, end to end through the engine: 10% then 40% costs one more
    // retrofit fee than 50% in one move. Zero volatility so the two runs share a base.
    const cfg: DeepPartial<GameConfig> = {
      emissions: { volatility: 0 },
      abatement: { lifetimeCap: 0.5 },
    }
    const spendOf = (s: Session) =>
      Object.values(s.state.years).reduce((sum, y) => sum + (y.abatementSpend.P1 ?? 0), 0)

    const oneMove = grandfathering(4, cfg)
    oneMove.startYear()
    oneMove.closeCapStage()
    oneMove.openTrade()
    oneMove.setAbatement('P1', 0.5)
    const fee = oneMove.abatementFixedCost('P1')
    expect(fee).toBeGreaterThan(0)

    const steppedSameYear = grandfathering(4, cfg)
    steppedSameYear.startYear()
    steppedSameYear.closeCapStage()
    steppedSameYear.openTrade()
    steppedSameYear.setAbatement('P1', 0.1)
    steppedSameYear.setAbatement('P1', 0.5)
    expect(spendOf(steppedSameYear) - spendOf(oneMove)).toBeCloseTo(fee, 1)

    // And across years — the same identity must hold when the step spans an openYear,
    // which is where the un-abated base could silently shift.
    const steppedAcrossYears = grandfathering(4, cfg)
    steppedAcrossYears.startYear()
    steppedAcrossYears.closeCapStage()
    steppedAcrossYears.openTrade()
    steppedAcrossYears.setAbatement('P1', 0.1)
    steppedAcrossYears.closeTrade()
    steppedAcrossYears.advanceYear()
    steppedAcrossYears.closeCapStage()
    steppedAcrossYears.openTrade()
    steppedAcrossYears.setAbatement('P1', 0.5)
    expect(spendOf(steppedAcrossYears) - spendOf(oneMove)).toBeCloseTo(fee, 1)
  })

  it('scales the retrofit fee with company size, not as a flat charge', () => {
    // A flat fee is ~7× Transport's annual emission but ~2× Power's, which would make the
    // whole mechanism a tax on being small.
    const s = grandfathering(6)
    const big = s.getPlayer('P1')!.emissions[DEFAULT_GAME_CONFIG.emissions.baselineYear]
    const small = s.getPlayer('P2')!.emissions[DEFAULT_GAME_CONFIG.emissions.baselineYear]
    expect(big).toBeGreaterThan(small)
    expect(s.abatementFixedCost('P1') / s.abatementFixedCost('P2')).toBeCloseTo(big / small, 6)
  })

  it('does not move this year\'s planned emissions, only next year\'s', () => {
    const s = grandfathering(8)
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    const planned = s.plannedEmission('P1')
    s.setAbatement('P1', 0.4)
    // The number every "how many credits do I need?" calculation reads is unchanged —
    // this is what the trade screen must display, and why it cannot track the slider.
    expect(s.plannedEmission('P1')).toBe(planned)
    s.closeTrade()
    s.advanceYear()
    expect(s.plannedEmission('P1')).toBeLessThan(planned)
  })

  it('scores the leaderboard on trading alone — investing is neither rewarded nor punished', () => {
    // The stated cost of the lag: this year's emissions and this year's spend are both
    // sunk by the time the year is scored, so the benchmark carries the spend on both
    // sides and it cancels. An investor's skill gap must be unaffected.
    const invests = grandfathering(9)
    const idle = grandfathering(9)
    for (const s of [invests, idle]) {
      s.startYear()
      s.closeCapStage()
      s.openTrade()
    }
    invests.setAbatement('P1', 0.4)
    for (const s of [invests, idle]) s.closeTrade()
    const gap = (s: Session) => round1(s.getPlayer('P1')!.score - s.getPlayer('P1')!.optimalScore)
    expect(gap(invests)).toBe(gap(idle))
    // The investment is still real money out the door — it is the GAP that is unchanged.
    expect(invests.getPlayer('P1')!.score).toBeGreaterThan(idle.getPlayer('P1')!.score)
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

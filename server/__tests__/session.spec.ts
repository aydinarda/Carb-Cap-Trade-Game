import { describe, expect, it } from 'vitest'
import { DEFAULT_GAME_CONFIG, resolveConfig, type DeepPartial, type GameConfig } from '../../shared/config'

const FIRST_GAME_YEAR = DEFAULT_GAME_CONFIG.emissions.firstGameYear
import { clearAuction, cumulativeCapFactor, installCost, round1 } from '../../shared/engine'
import { GameError, Session, SessionStore } from '../session'
import { hostSnapshot, playerSnapshot } from '../views'

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
 *
 * `perRoundCap` has to come off as well as `lifetimeCap`: the step limit is multiplicative,
 * so at the shipped 20% a single year reaches 20% and no amount of raising the lifetime
 * budget gets a company to zero emissions in one move.
 */
function unlimitedAbatement(seed = 1) {
  return grandfathering(seed, {
    abatement: { lifetimeCap: 1, perRoundCap: 1, fixedCostPerTonneBaseline: 0 },
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

function auctioning(seed = 1, override?: DeepPartial<GameConfig>) {
  const s = new Session('auctioning', seed, override)
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
    // Reserve off: the €15 bid is picked to make the ledger arithmetic obvious, and a floor
    // tied to the reference would simply reject it.
    const s = auctioning(1, { allocation: { auctionReserveFrac: 0 } })
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
  /**
   * The per-round step limit is switched OFF throughout this block. Both ceilings bind
   * `setAbatement`, so leaving the shipped 20% on would make every test here measure the
   * step limit while claiming to measure the lifetime budget — and the block would keep
   * passing if the lifetime cap were deleted outright. The step limit has its own block.
   */
  const NO_STEP = { abatement: { perRoundCap: 1 } }

  it('clamps a request above the budget instead of honouring it', () => {
    const s = grandfathering(1, NO_STEP)
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
      const s = new Session(mode, 1, NO_STEP)
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
    const s = grandfathering(1, { abatement: { lifetimeCap: 0.45, perRoundCap: 1 } })
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
    const s = grandfathering(1, { abatement: { lifetimeCap: 0.45, perRoundCap: 1 } })
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

/**
 * The per-round step limit — the second, independent ceiling.
 *
 * It exists because one ceiling was doing two jobs and doing the second one badly: measured
 * on the shipped parameters, the class went 0% → 6% → 40% and 70% of companies were welded
 * to the lifetime cap from round 3 to round 10, which left the back seven rounds with no
 * abatement decision in them at all. This block pins the properties that make the two
 * ceilings independent: the step composes as a PRODUCT, it cannot be walked around inside a
 * single round, and the lifetime budget still stops the path where it always did.
 */
describe('per-round abatement step limit', () => {
  /** Drive `s` to the start of the next year's trade stage. */
  const nextYear = (s: Session) => {
    s.closeTrade()
    s.advanceYear()
    s.closeCapStage()
    s.openTrade()
  }
  const open = (override?: DeepPartial<GameConfig>) => {
    const s = grandfathering(3, override)
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    return s
  }

  it('caps the first round at the step limit, however much is asked for', () => {
    const s = open()
    s.setAbatement('P1', 1)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.2)
    // The lifetime budget is untouched and still reads as the whole 50%.
    expect(s.lifetimeCapFor('P1')).toBe(0.5)
  })

  it('composes MULTIPLICATIVELY across rounds: 20% / 36% / 48.8% / 50%', () => {
    // The property the user specified: year1 × year2 × … of *retained* emissions, never a
    // flat 20 points a year. 0.8³ = 0.512 is still above the 0.5 floor; 0.8⁴ = 0.410 is not,
    // so the lifetime cap is what stops round 4 — not the step limit.
    const s = open()
    const path: number[] = []
    for (let i = 0; i < 4; i++) {
      s.setAbatement('P1', 1)
      path.push(s.getPlayer('P1')!.abatementCommitted)
      if (i < 3) nextYear(s)
    }
    expect(path).toEqual([0.2, 0.36, 0.49, 0.5])
  })

  it('cannot be ratcheted inside a single round by stepping repeatedly', () => {
    // The bug the round-opening anchor exists to prevent: measure against the LIVE committed
    // level and 20% → 36% → 48.8% all happen in round one.
    const s = open()
    for (let i = 0; i < 10; i++) s.setAbatement('P1', 1)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.2)
  })

  it('never lets the step limit carry a company past the lifetime budget', () => {
    // 40% a round would reach 64% in two rounds unchecked; the lifetime cap holds it at 50%.
    const s = open({ abatement: { perRoundCap: 0.4 } })
    s.setAbatement('P1', 1)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.4)
    nextYear(s)
    s.setAbatement('P1', 1)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.5)
  })

  it('is disabled by perRoundCap: 1, recovering the single-ceiling behaviour', () => {
    const s = open({ abatement: { perRoundCap: 1 } })
    s.setAbatement('P1', 1)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.5)
  })

  it('rises with a breakthrough only as fast as the step limit allows', () => {
    // A tech unlock raises the DESTINATION, not the pace — otherwise announcing one would
    // hand the whole extra budget over in the round it lands.
    const s = open()
    s.setAbatement('P1', 1)
    nextYear(s)
    s.announceTech() // lifetime cap 0.5 → 0.7
    expect(s.lifetimeCapFor('P1')).toBe(0.7)
    s.setAbatement('P1', 1)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.36)
  })

  it('rejects a nonsensical step limit rather than silently freezing the game', () => {
    // 0 would clamp every company to its opening level forever, which reads as a config
    // that disabled abatement — and would do it without a word.
    expect(() => grandfathering(1, { abatement: { perRoundCap: 0 } })).toThrow(/perRoundCap/)
    expect(() => grandfathering(1, { abatement: { perRoundCap: 1.5 } })).toThrow(/perRoundCap/)
  })
})

describe('abatement as permanent installed capacity', () => {
  const FREE = { abatement: { fixedCostPerTonneBaseline: 0 } }
  /**
   * This block is about the LAG (capacity bites next year) and the FEE (one per step), and
   * every test in it reaches 30-50% inside a single year to show them. The shipped 20%
   * per-round step limit would cap those moves and quietly turn each test into a test of
   * the pace instead, so it is switched off here. `perRoundCap` has its own block.
   */
  const NO_STEP = { abatement: { perRoundCap: 1 } }

  it('takes effect from the NEXT year, never the year it is bought', () => {
    // The lag, proved by identity: a session that installs in year 11 must realize exactly
    // what a same-seed session that installed nothing does. Same seed, same draws.
    const invests = grandfathering(7, NO_STEP)
    const idle = grandfathering(7, NO_STEP)
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
    const s = grandfathering(2, NO_STEP)
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
      abatement: { lifetimeCap: 0.5, perRoundCap: 1 },
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
    // The session applies a reserve price; the direct call has to be given the same one or
    // this compares two different auctions.
    const reserve = round1(s.openingReference() * s.state.config.allocation.auctionReserveFrac)
    const expected = clearAuction(rec.auctionBid, rec.regulatorPool, reserve)
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
    const s = auctioning(1, { allocation: { auctionReserveFrac: 0 } })
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

    // Year 1 has no discovered price yet, so the seed is priced at the opening anchor.
    // Derived: the anchor is calibration and has already moved from a half to a quarter.
    const { penaltyRate, openingReferenceFraction } = s.state.config.market
    expect(rec.primaryPrice).toBe(penaltyRate * openingReferenceFraction)
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

describe('the cap reduction schedule', () => {
  // The shipped schedule decelerates: 0.95 for the first nine rounds, then 0.965, 0.98, 0.99
  // and finally flat from round 20. A single factor cannot both build scarcity early and stop
  // building it later, which is what every long game kept running into.
  it('applies each round\'s factor cumulatively, not one factor exponentially', () => {
    const c = resolveConfig()
    const first = c.emissions.firstGameYear
    // Round 1 is the baseline the schedule shrinks FROM, so no reduction applies to it.
    expect(cumulativeCapFactor(c, first)).toBe(1)
    // Read the schedule rather than restating it: the factors are calibration and have
    // already moved once. What must hold is that they COMPOUND, round by round.
    const sched = c.allocation.capReductionSchedule
    const factorAt = (round: number) =>
      [...sched].filter((e) => e.fromRound <= round).pop()!.factor
    expect(cumulativeCapFactor(c, first + 1)).toBeCloseTo(factorAt(1), 9)
    expect(cumulativeCapFactor(c, first + 2)).toBeCloseTo(factorAt(1) * factorAt(2), 9)
    let expected = 1
    for (let r = 1; r <= 10; r++) expected *= factorAt(r)
    expect(cumulativeCapFactor(c, first + 10)).toBeCloseTo(expected, 9)
  })

  it('stops shrinking, and may loosen, once the schedule passes its trough', () => {
    const c = resolveConfig()
    const first = c.emissions.firstGameYear
    // The late entries sit ABOVE 1 deliberately: by then the class has spent its abatement
    // budget, so holding supply flat would still tighten against a market that cannot
    // respond. The cap therefore stops falling and begins to loosen.
    expect(cumulativeCapFactor(c, first + 25)).toBeGreaterThanOrEqual(
      cumulativeCapFactor(c, first + 20),
    )
  })

  it('rejects a schedule that is out of order or out of range', () => {
    expect(() =>
      resolveConfig({
        allocation: { capReductionSchedule: [{ fromRound: 5, factor: 0.9 }, { fromRound: 2, factor: 0.9 }] },
      }),
    ).toThrow(/ascend by fromRound/)
    expect(() =>
      resolveConfig({ allocation: { capReductionSchedule: [{ fromRound: 1, factor: 0 }] } }),
    ).toThrow(/must be in \(0, 1.5]/)
    expect(() =>
      resolveConfig({ allocation: { capReductionSchedule: [{ fromRound: 0, factor: 0.9 }] } }),
    ).toThrow(/1 or greater/)
  })

  it('setting the scalar factor means a FLAT factor, clearing the schedule', () => {
    // Otherwise an override is silently ignored: the schedule wins wherever both exist.
    const c = resolveConfig({ allocation: { capReductionFactor: 0.9 } })
    expect(c.allocation.capReductionSchedule).toEqual([])
    expect(cumulativeCapFactor(c, c.emissions.firstGameYear + 3)).toBeCloseTo(0.9 ** 3, 9)
  })

  it('the host panel clears it too, so a typed factor actually takes effect', () => {
    const s = grandfathering()
    s.updateSettings({ capReductionFactor: 0.8 })
    expect(s.state.config.allocation.capReductionSchedule).toEqual([])
  })
})

describe('updateSettings rejects what it cannot apply', () => {
  // The silent-drop this replaces: a knob the build does not have was ignored and the call
  // still acked ok, so a harness tuning it saw success and no effect.
  it('refuses an unknown key instead of acking success', () => {
    const s = grandfathering()
    expect(() => s.updateSettings({ nonsenseKnob: 1 } as never)).toThrow(/Unknown setting/)
  })

  it('names the offending key and what the build does accept', () => {
    const s = grandfathering()
    try {
      s.updateSettings({ marketMakerAggression: 2 } as never)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('marketMakerAggression')
      expect((e as Error).message).toContain('marketMakerInvFrac')
    }
  })

  it('still applies a well-formed batch', () => {
    const s = grandfathering()
    s.updateSettings({ marketMakerInvFrac: 0.3, penaltyRate: 120 })
    expect(s.state.config.bots.marketMaker.invFrac).toBe(0.3)
    expect(s.state.config.market.penaltyRate).toBe(120)
  })

  it('bounds the market-maker target', () => {
    const s = grandfathering()
    expect(() => s.updateSettings({ marketMakerInvFrac: 1.5 })).toThrow(/between 0 and 0.9/)
  })
})

describe('the optimum benchmark sees the carry', () => {
  it('a debtor is not measured as though it still had the allowances it owes', () => {
    // Year 11: no abatement, no trades -> P2 ends short and carries a make-good debt.
    //
    // The tight ratio is what MAKES a debtor. The shipped calibration issues the class its
    // full baseline in year one — scarcity arrives later, through the cap reduction — so at
    // the defaults nobody ends year 11 short and this test would silently assert nothing.
    const SHORT_Y11: DeepPartial<GameConfig> = { allocation: { freeCreditRatio: 0.5 } }
    const s = grandfathering(1, SHORT_Y11)
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
    const clean = grandfathering(1, SHORT_Y11)
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

/**
 * Green subsidy: a discount on installing abatement capacity, announced ahead of the round
 * it applies to.
 *
 * The lead time is the mechanism rather than a detail — a discount starting immediately is
 * a cheaper world, while one starting two rounds out is a decision about when to retrofit.
 * These pin that timing, and that everything pricing a retrofit agrees on the discount:
 * the charge, the agents' payback rule, and the scoring benchmark.
 */
describe('green subsidy', () => {
  const start = (mode: Parameters<typeof Session.prototype.setCapMode>[0] = 'benchmarking') => {
    const s = new Session(mode, 5)
    s.addPlayer('Alice', 'Power & Utilities')
    s.startYear()
    return s
  }

  it('starts after the announced lead, not immediately', () => {
    const s = start()
    const w = s.announceSubsidy(2)
    // Announced in round 11, shipped lead of 2 → rounds 13 and 14.
    expect(w.announcedIn).toBe(11)
    expect(w.fromYear).toBe(13)
    expect(w.toYear).toBe(14)
    expect(s.subsidyFactor(11)).toBe(1)
    expect(s.subsidyFactor(12)).toBe(1)
    expect(s.subsidyFactor(13)).toBe(0.75)
    expect(s.subsidyFactor(14)).toBe(0.75)
    // …and lifts on its own.
    expect(s.subsidyFactor(15)).toBe(1)
  })

  it('charges the discounted price while it runs, and full price before', () => {
    const full = start()
    full.closeCapStage(); full.openTrade()
    full.setAbatement('P1', 0.3)
    const fullSpend = full.currentYearRecord()!.abatementSpend.P1

    const cheap = start()
    // Announce so that it is already live in the round being played: the window is
    // addressed by year, so a lead-time test and a pricing test stay independent.
    cheap.announceSubsidy(3)
    cheap.state.subsidy!.fromYear = cheap.state.currentYear
    cheap.closeCapStage(); cheap.openTrade()
    cheap.setAbatement('P1', 0.3)
    const cheapSpend = cheap.currentYearRecord()!.abatementSpend.P1

    expect(cheapSpend).toBeCloseTo(round1(fullSpend * 0.75), 1)
    expect(cheapSpend).toBeLessThan(fullSpend)
  })

  it('is rejected for a nonsensical length, and can be withdrawn', () => {
    const s = start()
    expect(() => s.announceSubsidy(0)).toThrow(/between 1 and 20/)
    expect(() => s.announceSubsidy(99)).toThrow(/between 1 and 20/)
    s.announceSubsidy(3)
    expect(s.state.subsidy).not.toBeNull()
    s.cancelSubsidy()
    expect(s.state.subsidy).toBeNull()
    expect(s.subsidyFactor(13)).toBe(1)
  })

  it('does not charge the scoring benchmark full price for a subsidised round', () => {
    // The benchmark has to face the same price the company did. If it did not, a company
    // that correctly waited for the discount would read as having over-invested.
    const s = start()
    s.announceSubsidy(3)
    s.state.subsidy!.fromYear = s.state.currentYear
    s.closeCapStage(); s.openTrade()
    s.setAbatement('P1', 0.3)
    s.closeTrade()
    const p = s.getPlayer('P1')!
    // Following the payback rule under the discount must not itself create a gap.
    expect(p.investmentGapTotal).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(p.investmentGapTotal)).toBe(true)
  })
})

/**
 * Energy crisis: gas is short, coal comes back, and the whole class emits more for a window
 * the instructor sets.
 *
 * The event that most easily goes wrong in a way nobody notices. Expectations are a random
 * walk off last year's REALIZED emission, so a naive standing multiplier compounds — three
 * rounds at 10% would leave the class 33% above trend and never come back down. These pin the
 * step-up/hold/step-down shape, that the step down actually happens (including when the
 * instructor lifts it early), and that a round which has already settled can never have the
 * level it was drawn at rewritten underneath it.
 */
describe('energy crisis', () => {
  const start = () => {
    const s = new Session('benchmarking', 5)
    s.addPlayer('Alice', 'Power & Utilities')
    s.startYear()
    return s
  }
  /** Play the open round out and move to the next one. */
  const nextRound = (s: Session) => {
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    s.advanceYear()
  }

  it('steps up once, holds, then steps back onto the original trend', () => {
    const s = start()
    const w = s.announceEnergyCrisis(3)
    expect(w.announcedIn).toBe(11)
    // No lead: it lands in the round it was declared in.
    expect(w.fromYear).toBe(11)
    expect(w.toYear).toBe(13)

    expect(s.emissionFactorFor(11)).toBeCloseTo(1.1, 6) // the step up
    expect(s.emissionFactorFor(12)).toBeCloseTo(1, 6) // holds — NOT another 10%
    expect(s.emissionFactorFor(13)).toBeCloseTo(1, 6)
    expect(s.emissionFactorFor(14)).toBeCloseTo(1 / 1.1, 6) // the step back down

    // The window multiplies out to exactly 1: the class ends on the trend it would have been
    // on. `×0.9` undoing a `×1.1` would leave it permanently 1% short of that.
    const product = [11, 12, 13, 14].reduce((p, y) => p * s.emissionFactorFor(y), 1)
    expect(product).toBeCloseTo(1, 10)
  })

  it('holds the class 10% above trend for the window, never 21% or 33%', () => {
    const plain = start()
    const crisis = start()
    crisis.announceEnergyCrisis(3) // rounds 11-13

    const ratios: number[] = []
    for (let round = 0; round < 4; round++) {
      ratios.push(crisis.plannedEmission('P1') / plain.plannedEmission('P1'))
      nextRound(plain)
      nextRound(crisis)
    }
    // Rounds 11-13 raised by the same single step; round 14 back on trend.
    expect(ratios[0]).toBeCloseTo(1.1, 3)
    expect(ratios[1]).toBeCloseTo(1.1, 3)
    expect(ratios[2]).toBeCloseTo(1.1, 3)
    expect(ratios[3]).toBeCloseTo(1, 3)
  })

  it('draws emissions around exactly the number the class was shown', () => {
    // `plannedEmission` is documented as the mean the draw is centred on, and every cover
    // decision is taken against it. A shock the draw could see and the screen could not would
    // charge the class for tonnes nobody was told about.
    const plain = start()
    const crisis = start()
    crisis.announceEnergyCrisis(1)
    expect(crisis.plannedEmission('P1')).toBeCloseTo(plain.plannedEmission('P1') * 1.1, 1)

    for (const s of [plain, crisis]) {
      s.closeCapStage()
      s.openTrade()
      s.closeTrade()
    }
    // Same seed, same call order, so the standard normal drawn is identical and the two
    // realizations differ by exactly the shock.
    const shocked = crisis.state.years[11].realized.P1
    const trend = plain.state.years[11].realized.P1
    expect(shocked / trend).toBeCloseTo(1.1, 3)
  })

  it('lands in the round on screen, or the next one once that round has settled', () => {
    const during = start()
    during.closeCapStage()
    during.openTrade() // mid-trade: emissions are still undrawn
    expect(during.announceEnergyCrisis(2).fromYear).toBe(11)
    expect(during.currentYearRecord()!.emissionFactor).toBeCloseTo(1.1, 6)

    const after = start()
    after.closeCapStage()
    after.openTrade()
    after.closeTrade() // year 11 is settled; the class has been charged for it
    expect(after.announceEnergyCrisis(2).fromYear).toBe(12)
    expect(after.state.years[11].emissionFactor).toBe(1)
  })

  it('steps back down when lifted early rather than stranding the class', () => {
    // The defect this guards: nulling the window would delete the step DOWN along with it and
    // leave the class 10% above trend for the rest of the game, with nothing ever saying so.
    const s = start()
    s.announceEnergyCrisis(5) // rounds 11-15
    nextRound(s) // year 11 realized under the crisis; now in year 12
    expect(s.emissionFactorFor(12)).toBeCloseTo(1, 6)

    s.cancelEnergyCrisis()
    expect(s.state.energyCrisis!.toYear).toBe(11) // truncated, not deleted
    expect(s.emissionFactorFor(12)).toBeCloseTo(1 / 1.1, 6)
    expect(s.currentYearRecord()!.emissionFactor).toBeCloseTo(1 / 1.1, 6)
  })

  it('drops a crisis outright when it never took effect', () => {
    const s = start()
    s.closeCapStage()
    s.openTrade()
    s.closeTrade() // year 11 settled, so a crisis declared now opens in year 12
    s.announceEnergyCrisis(3)
    expect(s.state.energyCrisis!.fromYear).toBe(12)
    s.cancelEnergyCrisis()
    // Nothing stepped up, so there is nothing to step back down from.
    expect(s.state.energyCrisis).toBeNull()
    expect(s.emissionFactorFor(12)).toBe(1)
  })

  it('never rewrites the level a settled round was drawn at', () => {
    const s = start()
    s.announceEnergyCrisis(4)
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    const stamped = s.state.years[11].emissionFactor
    expect(stamped).toBeCloseTo(1.1, 6)
    // Withdrawing afterwards must not move the number year 11 was scored against.
    s.cancelEnergyCrisis()
    expect(s.state.years[11].emissionFactor).toBe(stamped)
  })

  it('extends a running crisis instead of firing the step up a second time', () => {
    const s = start()
    s.announceEnergyCrisis(2) // rounds 11-12
    nextRound(s) // now in round 12, still inside the window
    const again = s.announceEnergyCrisis(3) // three more rounds from here
    expect(again.fromYear).toBe(11) // unchanged — the step was already taken
    expect(again.toYear).toBe(14)
    expect(s.emissionFactorFor(12)).toBeCloseTo(1, 6) // holding, not stepping again
    expect(s.emissionFactorFor(15)).toBeCloseTo(1 / 1.1, 6)
  })

  it('is rejected for a nonsensical length', () => {
    const s = start()
    expect(() => s.announceEnergyCrisis(0)).toThrow(/between 1 and 20/)
    expect(() => s.announceEnergyCrisis(99)).toThrow(/between 1 and 20/)
    expect(s.state.energyCrisis).toBeNull()
  })

  it('leaves an ordinary session at a factor of exactly 1', () => {
    // The whole event must be inert when nobody declares one — `golden.spec.ts` pins the
    // engine's literal output and would move if this drifted.
    const s = start()
    expect(s.currentYearRecord()!.emissionFactor).toBe(1)
    expect(s.emissionFactorFor(11)).toBe(1)
    expect(s.energyCrisisActive).toBe(false)
  })
})

/**
 * Interest-rate cut: cheap credit, pulling the game two ways at once — retrofits get cheaper,
 * and the demand it creates pushes emissions up.
 *
 * Two things need pinning that no other event needs. The first is that its magnitudes never
 * reach a player: the event's whole design is that the class infers the mechanics from its own
 * numbers, and a snapshot that leaked them would quietly undo that. The second is composition
 * — it is the first event to share BOTH the emission level and the install-cost factor with
 * another event, and the failure mode there is silent (one shock masking the other, or one
 * unwinding taking the other's step with it).
 */
describe('interest-rate cut', () => {
  const start = () => {
    const s = new Session('benchmarking', 5)
    s.addPlayer('Alice', 'Power & Utilities')
    s.startYear()
    return s
  }
  const nextRound = (s: Session) => {
    s.closeCapStage()
    s.openTrade()
    s.closeTrade()
    s.advanceYear()
  }

  it('runs its configured length from the round it is triggered in', () => {
    const s = start()
    const cut = s.announceRateCut()
    expect(cut.announcedIn).toBe(11)
    expect(cut.fromYear).toBe(11) // no lead, like the energy crisis
    expect(cut.toYear).toBe(12) // the shipped two rounds
    expect(cut.investmentDiscount).toBe(0.07)
    expect(cut.demandIncrease).toBe(0.08)
  })

  it('takes 7% off the capacity itself', () => {
    // Measured against the company's OWN base for the round, which the demand arm has already
    // raised. That is what the discount is a discount on: the price of capacity, not the size
    // of the problem.
    const s = start()
    s.announceRateCut()
    s.closeCapStage(); s.openTrade()
    const spec = s.state.config.abatement.sectors['Power & Utilities']
    const undiscounted = round1(
      installCost(s.unabatedEmission('P1'), 0, 0.2, spec, s.abatementFixedCost('P1')),
    )
    s.setAbatement('P1', 0.2)
    expect(s.currentYearRecord()!.abatementSpend.P1).toBeCloseTo(round1(undiscounted * 0.93), 1)
  })

  it('does NOT make the same abatement TARGET 7% cheaper — the base grew too', () => {
    // The interaction worth knowing before an instructor promises the class a discount. A
    // company aiming at "20% of my emissions" is buying 8% more tonnes than it would have
    // been, so reaching that target lands only ~2% cheaper even at 7% off the price. Cheap
    // credit does not, on its own, make the compliance problem smaller.
    const full = start()
    full.closeCapStage(); full.openTrade()
    full.setAbatement('P1', 0.2)
    const fullSpend = full.currentYearRecord()!.abatementSpend.P1

    const cut = start()
    cut.announceRateCut()
    cut.closeCapStage(); cut.openTrade()
    cut.setAbatement('P1', 0.2)
    const cutSpend = cut.currentYearRecord()!.abatementSpend.P1

    expect(cutSpend).toBeLessThan(fullSpend)
    // Nowhere near the 7% a reader of the discount alone would expect.
    expect(cutSpend / fullSpend).toBeGreaterThan(0.95)
    expect(cutSpend / fullSpend).toBeLessThan(1)
  })

  it('steps emissions up by the demand arm, then back down', () => {
    const s = start()
    s.announceRateCut() // rounds 11-12
    expect(s.emissionFactorFor(11)).toBeCloseTo(1.08, 6)
    expect(s.emissionFactorFor(12)).toBeCloseTo(1, 6)
    expect(s.emissionFactorFor(13)).toBeCloseTo(1 / 1.08, 6)
    const product = [11, 12, 13].reduce((p, y) => p * s.emissionFactorFor(y), 1)
    expect(product).toBeCloseTo(1, 10)
  })

  it('composes with an energy crisis instead of masking it', () => {
    // Different causes — fuel substitution and cheap credit — so a class living through both
    // emits more than either produces alone. Taking the larger would make the second free.
    const s = start()
    s.announceEnergyCrisis(4) // rounds 11-14
    s.announceRateCut() // rounds 11-12
    expect(s.emissionFactorFor(11)).toBeCloseTo(1.1 * 1.08, 6)

    nextRound(s) // round 12: both still running, nothing steps
    expect(s.emissionFactorFor(12)).toBeCloseTo(1, 6)

    // Round 13: the rate cut lifts while the crisis keeps running. Exactly the cut's own step
    // unwinds; the crisis holds its level untouched.
    expect(s.emissionFactorFor(13)).toBeCloseTo(1 / 1.08, 6)
    // Round 15: now the crisis lifts too, and only its step comes off.
    expect(s.emissionFactorFor(15)).toBeCloseTo(1 / 1.1, 6)
    // End to end the two windows leave the class exactly on its original trend.
    const product = [11, 12, 13, 14, 15].reduce((p, y) => p * s.emissionFactorFor(y), 1)
    expect(product).toBeCloseTo(1, 10)
  })

  it('compounds its discount with a running subsidy', () => {
    const s = start()
    s.announceSubsidy(3)
    s.state.subsidy!.fromYear = s.state.currentYear
    s.announceRateCut()
    // 25% off and 7% off are different programmes; a company faces both.
    expect(s.installCostFactor(11)).toBeCloseTo(0.75 * 0.93, 6)
    // …and the subsidy-only view still answers about the subsidy alone.
    expect(s.subsidyFactor(11)).toBeCloseTo(0.75, 6)
  })

  it('prices the scoring benchmark at the covert discount too', () => {
    // The benchmark has to face what the company faced. If it did not, a company that
    // correctly took a discount it was never told about would read as having over-invested.
    const s = start()
    s.announceRateCut()
    s.closeCapStage(); s.openTrade()
    s.setAbatement('P1', 0.2)
    s.closeTrade()
    const p = s.getPlayer('P1')!
    expect(p.investmentGapTotal).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(p.investmentGapTotal)).toBe(true)
  })

  it('keeps both magnitudes out of the player snapshot', () => {
    // The one guarantee the event rests on. `playerSnapshot` rebuilds the notice field by
    // field rather than spreading, and this is what would catch a future spread.
    const s = start()
    s.announceRateCut()
    const view = playerSnapshot(s, 'P1')
    expect(view.rateCut).toEqual({ announcedIn: 11, fromYear: 11, toYear: 12 })
    expect(JSON.stringify(view)).not.toContain('investmentDiscount')
    expect(JSON.stringify(view)).not.toContain('demandIncrease')
    // What the class DOES get is the composed price it will actually be charged.
    expect(view.abatementCostFactor).toBeCloseTo(0.93, 6)

    // The host, by contrast, sees everything.
    const host = hostSnapshot(s)
    expect(host.rateCut?.investmentDiscount).toBe(0.07)
    expect(host.rateCut?.demandIncrease).toBe(0.08)
  })

  it('unwinds the demand step when ended early', () => {
    const s = start()
    s.announceRateCut() // rounds 11-12
    nextRound(s) // round 11 realized under it; now in round 12
    s.cancelRateCut()
    expect(s.state.rateCut!.toYear).toBe(11) // truncated, not deleted
    expect(s.emissionFactorFor(12)).toBeCloseTo(1 / 1.08, 6)
    // And the discount is gone from this round's pricing.
    expect(s.installCostFactor(12)).toBe(1)
  })

  it('is inert until triggered', () => {
    const s = start()
    expect(s.state.rateCut).toBeNull()
    expect(s.installCostFactor(11)).toBe(1)
    expect(s.emissionFactorFor(11)).toBe(1)
    expect(s.rateCutActive).toBe(false)
    // A crisis must not make the rate-cut getter answer true, or vice versa.
    s.announceEnergyCrisis(2)
    expect(s.rateCutActive).toBe(false)
    expect(s.energyCrisisActive).toBe(true)
  })
})

/**
 * Technology breakthrough: a higher lifetime abatement budget.
 *
 * Modelled per company from the start even though the only trigger today is a class-wide
 * announcement — the intended next step is a company earning its own unlock, and these pin
 * that nothing downstream reads a single global ceiling any more.
 */
describe('technology breakthrough', () => {
  const start = () => {
    // Step limit off: this block asserts where the LIFETIME ceiling lands (0.5 -> 0.7), and
    // at the shipped 20% per round every install here would clamp to 0.2 and prove nothing.
    const s = new Session('benchmarking', 5, { abatement: { perRoundCap: 1 } })
    s.addPlayer('Alice', 'Power & Utilities')
    s.addPlayer('Bob', 'Heavy Materials')
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    return s
  }

  it('raises the ceiling for the whole class when scope is null', () => {
    const s = start()
    expect(s.lifetimeCapFor('P1')).toBe(DEFAULT_GAME_CONFIG.abatement.lifetimeCap)
    s.announceTech()
    expect(s.lifetimeCapFor('P1')).toBe(0.7)
    expect(s.lifetimeCapFor('P2')).toBe(0.7)
  })

  it('lets a company install past the old cap, and clamps at the new one', () => {
    const s = start()
    // The old ceiling really does bind first.
    s.setAbatement('P1', 0.9)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.5)
    s.announceTech()
    s.setAbatement('P1', 0.9)
    expect(s.getPlayer('P1')!.abatementCommitted).toBe(0.7)
  })

  it('applies to only the companies in scope — the per-player path', () => {
    const s = start()
    s.announceTech({ scope: ['P1'], label: 'Pilot plant' })
    expect(s.lifetimeCapFor('P1')).toBe(0.7)
    expect(s.lifetimeCapFor('P2')).toBe(DEFAULT_GAME_CONFIG.abatement.lifetimeCap)
    s.setAbatement('P2', 0.9)
    expect(s.getPlayer('P2')!.abatementCommitted).toBe(0.5)
  })

  it('composes by maximum, so two unlocks cannot stack past 100%', () => {
    const s = start()
    s.announceTech({ cap: 0.6 })
    s.announceTech({ cap: 0.8 })
    expect(s.lifetimeCapFor('P1')).toBe(0.8)
    s.announceTech({ cap: 0.7 })
    expect(s.lifetimeCapFor('P1')).toBe(0.8) // the deepest still wins, not the latest
  })

  it('honours a lead time and can be withdrawn', () => {
    const s = new Session('benchmarking', 5, { abatement: { tech: { leadRounds: 2 } } })
    s.addPlayer('Alice', 'Power & Utilities')
    s.startYear()
    const u = s.announceTech()
    expect(u.fromYear).toBe(13)
    expect(s.lifetimeCapFor('P1', 11)).toBe(DEFAULT_GAME_CONFIG.abatement.lifetimeCap)
    expect(s.lifetimeCapFor('P1', 13)).toBe(0.7)
    s.cancelTech(u.id)
    expect(s.lifetimeCapFor('P1', 13)).toBe(DEFAULT_GAME_CONFIG.abatement.lifetimeCap)
  })

  it('rejects a nonsensical ceiling', () => {
    const s = start()
    expect(() => s.announceTech({ cap: 0 })).toThrow(/between 0 and 1/)
    expect(() => s.announceTech({ cap: 1.5 })).toThrow(/between 0 and 1/)
  })
})

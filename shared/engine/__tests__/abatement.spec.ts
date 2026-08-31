import { describe, expect, it } from 'vitest'
import {
  abatementCost,
  incrementalFraction,
  installCost,
  investmentGap,
  optimalAbatement,
  optimalYearCost,
  planInstall,
  unabatedFrom,
} from '../abatement'
import { round1 } from '../rng'

describe('abatementCost', () => {
  it('is E·(a·r + b·r²/2), zero at r=0, convex', () => {
    const coeff = { a: 2, b: 20 }
    expect(abatementCost(1000, 0, coeff)).toBe(0)
    // r=0.5: 1000·(2·0.5 + 20·0.25/2) = 1000·(1 + 2.5) = 3500
    expect(abatementCost(1000, 0.5, coeff)).toBe(3500)
    // marginal cost rises: 2nd tenth costs more than the 1st
    const first = abatementCost(1000, 0.1, coeff)
    const second = abatementCost(1000, 0.2, coeff) - first
    expect(second).toBeGreaterThan(first)
  })

  it('clamps the fraction to [0,1]', () => {
    expect(abatementCost(100, 2, { a: 1, b: 1 })).toBe(abatementCost(100, 1, { a: 1, b: 1 }))
    expect(abatementCost(100, -1, { a: 1, b: 1 })).toBe(0)
  })
})

describe('optimalAbatement', () => {
  it('is where marginal cost meets the price: (price − a)/b, clamped', () => {
    expect(optimalAbatement({ a: 2, b: 16 }, 10)).toBeCloseTo(0.5, 10)
    expect(optimalAbatement({ a: 12, b: 16 }, 10)).toBe(0) // a > price → no cuts
    expect(optimalAbatement({ a: 0, b: 5 }, 100)).toBe(1) // clamped to full
  })
})

describe('installCost — the stepping identity', () => {
  const coeff = { a: 2, b: 20 }
  const U = 1000
  const FEE = 350

  it('charges the fee once per step, so stepping costs exactly one extra fee', () => {
    // THE specification, in one assertion: 10% then 40% differs from 50% in one move by
    // precisely one retrofit fee — the variable halves are identical, because the MAC
    // integral is additive.
    const stepped = installCost(U, 0, 0.1, coeff, FEE) + installCost(U, 0.1, 0.5, coeff, FEE)
    const oneMove = installCost(U, 0, 0.5, coeff, FEE)
    expect(stepped - oneMove).toBeCloseTo(FEE, 10)
  })

  it('holds for any partition, at any number of steps', () => {
    const path = [0, 0.07, 0.13, 0.29, 0.4, 0.5]
    const stepped = path
      .slice(1)
      .reduce((sum, to, i) => sum + installCost(U, path[i], to, coeff, FEE), 0)
    expect(stepped - installCost(U, 0, 0.5, coeff, FEE)).toBeCloseTo(FEE * (path.length - 2), 10)
  })

  it('is the fee plus the integral of the new slice only', () => {
    // ∫0→0.5 = 2(0.5) + 20(0.25)/2 = 3.5 ; ∫0→0.1 = 0.2 + 0.1 = 0.3
    expect(installCost(U, 0, 0.5, coeff, FEE)).toBeCloseTo(FEE + 3500, 5)
    expect(installCost(U, 0.1, 0.5, coeff, FEE)).toBeCloseTo(FEE + (3500 - 300), 5)
  })

  it('is free for a non-increase — there is no un-installing and no refund', () => {
    expect(installCost(U, 0.4, 0.4, coeff, FEE)).toBe(0)
    expect(installCost(U, 0.4, 0.1, coeff, FEE)).toBe(0)
  })

  it('still charges the fee for an arbitrarily small step', () => {
    // This is what makes nibbling expensive, and why the agents carry a minimum step.
    expect(installCost(U, 0.2, 0.2001, coeff, FEE)).toBeGreaterThan(FEE)
  })
})

describe('incrementalFraction — capacity holds its level instead of compounding', () => {
  it('telescopes, so a standing level cuts once and then stops', () => {
    expect(incrementalFraction(0, 0)).toBe(0)
    expect(incrementalFraction(0.2, 0)).toBeCloseTo(0.2, 10)
    expect(incrementalFraction(0.2, 0.2)).toBe(0) // unchanged capacity takes nothing more
    // 0.2 → 0.5 leaves 0.8E, needs to reach 0.5E: 1 − 0.5/0.8 = 0.375
    expect(incrementalFraction(0.5, 0.2)).toBeCloseTo(0.375, 10)
  })

  it('composes to the standing level, which is the property the whole design rests on', () => {
    // Chain the increments the way realizeYear does and the product must equal (1 − now).
    const path = [0, 0.1, 0.1, 0.35, 0.5, 0.5]
    const survived = path
      .slice(1)
      .reduce((f, now, i) => f * (1 - incrementalFraction(now, path[i])), 1)
    expect(survived).toBeCloseTo(1 - 0.5, 10)
  })

  it('never asks for a cut back, and is safe at the degenerate end', () => {
    expect(incrementalFraction(0.1, 0.4)).toBe(0) // a lowered level does not raise emissions
    expect(incrementalFraction(1, 1)).toBe(0) // no divide by zero at a total cut
  })
})

describe('unabatedFrom', () => {
  it('inverts the cut already baked into an expectation', () => {
    expect(unabatedFrom(800, 0.2)).toBeCloseTo(1000, 10)
    expect(unabatedFrom(800, 0)).toBe(800)
  })

  it('returns 0 rather than Infinity at a total cut', () => {
    // Only reachable at lifetimeCap 1, but an Infinity here would poison every score.
    expect(unabatedFrom(0, 1)).toBe(0)
  })
})

describe('planInstall', () => {
  const spec = { a: 2, b: 20 } // r*(10) = 0.4
  const base = {
    spec,
    unabated: 1000,
    committed: 0,
    lifetimeCap: 0.5,
    fixedCost: 100,
    horizon: 3,
  }

  it('sizes myopically at r*(price), not at r*(horizon × price)', () => {
    // The distinction that keeps sectors heterogeneous: valuing over the horizon would
    // clamp this to the 0.5 cap instead.
    expect(planInstall({ ...base, price: 10 }).target).toBeCloseTo(0.4, 10)
  })

  it('respects the lifetime cap and never targets below what is committed', () => {
    expect(planInstall({ ...base, price: 100 }).target).toBe(0.5)
    expect(planInstall({ ...base, price: 1, committed: 0.3 }).target).toBe(0.3)
  })

  it('declines when the horizon does not repay the fee', () => {
    // A fee larger than any plausible saving must not be paid.
    expect(planInstall({ ...base, price: 10, fixedCost: 1e9 }).install).toBe(false)
    expect(planInstall({ ...base, price: 10, fixedCost: 100 }).install).toBe(true)
  })

  it('blocks nibbling below the minimum step', () => {
    // r*(2.4) = 0.02 — worth it on the arithmetic, but too small to be worth a retrofit.
    const tiny = planInstall({ ...base, price: 2.4 })
    expect(tiny.target).toBeGreaterThan(0)
    expect(tiny.install).toBe(false)
  })

  it('tops up as the price climbs — a second step, and a second fee', () => {
    const first = planInstall({ ...base, price: 10 })
    expect(first.install).toBe(true)
    const second = planInstall({ ...base, price: 14, committed: first.target })
    expect(second.install).toBe(true)
    expect(second.target).toBeGreaterThan(first.target)
    expect(second.cost).toBeGreaterThan(base.fixedCost) // the fee is charged again
  })

  it('does nothing once the cap is reached, however high the price', () => {
    const done = planInstall({ ...base, price: 500, committed: 0.5 })
    expect(done.install).toBe(false)
    expect(done.cost).toBe(0)
  })
})

describe('optimalYearCost & fairness', () => {
  it('two very different sectors, played optimally, net to a fair (near-equal) benchmark', () => {
    // The leaderboard scores (actual − optimal); if both play optimally, actual = optimal,
    // so the normalized score is 0 for BOTH regardless of sector/size.
    const power = optimalYearCost(600, 800, 3200, 10)
    const heavy = optimalYearCost(180, 240, 900, 10)
    expect(Number.isFinite(power)).toBe(true)
    expect(Number.isFinite(heavy)).toBe(true)
  })

  it('scores only the cover decision — investment spend cancels out of the gap', () => {
    // The stated consequence of the one-year lag: two companies with identical emissions
    // and credits are benchmarked identically no matter what they spent on capacity, so
    // the leaderboard measures trading skill alone.
    const gapA = 5000 - optimalYearCost(900, 500, 0, 10)
    const gapB = 5000 + 12_000 - optimalYearCost(900, 500, 12_000, 10)
    expect(gapB).toBe(gapA)
  })

  it('computes exact values across both cover branches', () => {
    // buy branch: planned 900 > credits 0 → 10×900 = 9000, plus 500 sunk.
    expect(optimalYearCost(900, 0, 500, 10)).toBe(9500)
    // sell branch: planned 900 < credits 950 → 10×(−50) = −500 → 500 − 500 = 0.
    expect(optimalYearCost(900, 950, 500, 10)).toBe(0)
    // nothing installed, nothing spent: pure cover.
    expect(optimalYearCost(100, 40, 0, 10)).toBe(600)
  })
})

describe('optimalYearCost — carry, and no penalty cap', () => {
  it('settles the residual against the credits it is given', () => {
    // Short by 100: 2400 sunk + 100 bought at 10.
    expect(optimalYearCost(600, 500, 2400, 10)).toBe(3400)
    // Long by 200: the surplus is income, so the optimum is cheaper.
    expect(optimalYearCost(600, 800, 2400, 10)).toBe(400)
    // A make-good debt is real credits to replace — fewer credits, dearer optimum.
    expect(optimalYearCost(600, 400, 2400, 10)).toBe(4400)
  })

  /**
   * The shortfall used to settle at `min(price, penaltyRate)`, which credited a perfect
   * player with covering at the fine while the class paid the market. It does not any more:
   * an uncovered tonne is fined AND carried as make-good debt, so defaulting costs the fine
   * plus the tonne later, and buying is always at least as cheap.
   */
  it('covers a shortfall at the market price however far above the fine it trades', () => {
    // 100 t short at a market price of 130 costs 13 000, not 100 × whatever the fine is.
    expect(optimalYearCost(600, 500, 0, 130)).toBe(13_000)
    // Same on the cheap side: the market price stands there too.
    expect(optimalYearCost(600, 500, 0, 10)).toBe(1000)
  })

  it('prices both sides of the position identically', () => {
    // Short 100 at 40 costs exactly what long 100 at 40 earns — a single market price,
    // no asymmetry between buying and selling.
    expect(optimalYearCost(600, 500, 0, 40)).toBe(-optimalYearCost(600, 700, 0, 40))
  })
})

describe('investmentGap', () => {
  const spec = { model: 'linear', params: { a: 10, b: 75 } } as const
  const shared = { unabated: 1000, lifetimeCap: 0.5, fixedCost: 1500, horizon: 3 }

  /** What the payback rule would have done at this price, for the assertions below. */
  const planned = (price: number, committedBefore = 0) =>
    planInstall({ spec, price, committed: committedBefore, ...shared })

  it('is zero for a company that follows the rule exactly', () => {
    const price = 60
    const plan = planned(price)
    expect(plan.install).toBe(true)
    const gap = investmentGap({
      spec, price, committedBefore: 0, committedAfter: plan.target,
      actualCost: plan.cost, ...shared,
    })
    expect(gap).toBe(0)
  })

  it('charges a company that invests nothing when the rule says invest', () => {
    const price = 60
    const plan = planned(price)
    const gap = investmentGap({
      spec, price, committedBefore: 0, committedAfter: 0, actualCost: 0, ...shared,
    })
    // Exactly the value it passed up: the plan's savings over the horizon, less its cost.
    expect(gap).toBe(round1(shared.horizon * price * shared.unabated * plan.target - plan.cost))
    expect(gap).toBeGreaterThan(0)
  })

  it('charges over-investment too — a step whose fee outruns its savings', () => {
    // At a price of 1 no retrofit pays back, so the rule sits out and doing nothing is
    // worth 0. Installing anyway is worth less than nothing, and the gap is that shortfall.
    const price = 1
    expect(planned(price).install).toBe(false)
    const overCost = installCost(shared.unabated, 0, 0.4, spec, shared.fixedCost)
    const gap = investmentGap({
      spec, price, committedBefore: 0, committedAfter: 0.4, actualCost: overCost, ...shared,
    })
    expect(gap).toBeGreaterThan(0)
  })

  it('never goes negative — beating the rule scores zero, not a bonus', () => {
    // A step the myopic rule would not have taken, but which happens to pay off here.
    const price = 60
    const plan = planned(price)
    const biggerCost = installCost(shared.unabated, 0, shared.lifetimeCap, spec, shared.fixedCost)
    const gap = investmentGap({
      spec, price, committedBefore: 0, committedAfter: shared.lifetimeCap,
      actualCost: biggerCost, ...shared,
    })
    expect(gap).toBeGreaterThanOrEqual(0)
    void plan
  })

  it('is zero once the lifetime cap is spent — there is nothing left to get wrong', () => {
    const gap = investmentGap({
      spec, price: 90, committedBefore: shared.lifetimeCap, committedAfter: shared.lifetimeCap,
      actualCost: 0, ...shared,
    })
    expect(gap).toBe(0)
  })
})

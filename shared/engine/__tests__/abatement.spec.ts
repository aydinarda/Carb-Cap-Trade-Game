import { describe, expect, it } from 'vitest'
import {
  abatementCost,
  incrementalFraction,
  installCost,
  optimalAbatement,
  optimalYearCost,
  planInstall,
  unabatedFrom,
} from '../abatement'

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

describe('optimalYearCost — carry and the penalty cap', () => {
  it('settles the residual against the credits it is given', () => {
    // Short by 100: 2400 sunk + 100 bought at 10.
    expect(optimalYearCost(600, 500, 2400, 10)).toBe(3400)
    // Long by 200: the surplus is income, so the optimum is cheaper.
    expect(optimalYearCost(600, 800, 2400, 10)).toBe(400)
    // A make-good debt is real credits to replace — fewer credits, dearer optimum.
    expect(optimalYearCost(600, 400, 2400, 10)).toBe(4400)
  })

  it('never pays more than the fine to cover a shortfall', () => {
    // Buying at 10 would cost 1000 for the 100 t gap, but the fine is only 5/t.
    expect(optimalYearCost(600, 500, 2400, 10, 5)).toBe(2900)
    // When the market is cheaper than the fine, the market price stands.
    expect(optimalYearCost(600, 500, 2400, 10, 50)).toBe(3400)
  })

  it('caps only the buying side — surplus is always sold at the market price', () => {
    expect(optimalYearCost(600, 800, 2400, 10, 1)).toBe(optimalYearCost(600, 800, 2400, 10))
  })
})

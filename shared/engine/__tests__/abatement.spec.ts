import { describe, expect, it } from 'vitest'
import { abatementCost, optimalAbatement, optimalYearCost } from '../abatement'

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

describe('optimalYearCost & fairness', () => {
  it('two very different sectors, played optimally, net to a fair (near-equal) benchmark', () => {
    // The leaderboard scores (actual − optimal); if both play optimally, actual = optimal,
    // so the normalized score is 0 for BOTH regardless of sector/size. Verify the benchmark
    // is well-defined and finite for wildly different sectors + sizes.
    const power = optimalYearCost(1000, 800, { a: 2, b: 15 }, 10, 10)
    const heavy = optimalYearCost(300, 240, { a: 8, b: 30 }, 10, 10)
    expect(Number.isFinite(power)).toBe(true)
    expect(Number.isFinite(heavy)).toBe(true)
    // Deviating from the optimum can only cost more than the optimum benchmark.
    const suboptimal = optimalAbatement({ a: 2, b: 15 }, 10)
    const worse = abatementCost(1000, suboptimal + 0.2, { a: 2, b: 15 }) + 10 * (1000 * (1 - (suboptimal + 0.2)) - 800)
    expect(worse).toBeGreaterThan(power)
  })
})

import { describe, expect, it } from 'vitest'
import { INDUSTRIES, INDUSTRY_NAMES } from '../../constants'
import { generateHistoryForIndustry } from '../playerGeneration'
import { createRng } from '../rng'

describe('generateHistoryForIndustry', () => {
  it('respects the chosen industry (student choice at join)', () => {
    const rng = createRng(5)
    for (const industry of INDUSTRY_NAMES) {
      const profile = generateHistoryForIndustry(industry, rng)
      expect(profile.industry).toBe(industry)
      expect(Object.keys(profile.emissions)).toHaveLength(10)
    }
  })

  it('is deterministic for a given seed and industry', () => {
    const a = generateHistoryForIndustry('Power & Utilities', createRng(42))
    const b = generateHistoryForIndustry('Power & Utilities', createRng(42))
    expect(a).toEqual(b)
  })

  it('produces histories consistent with the notebook formulas', () => {
    const rng = createRng(7)
    for (let i = 0; i < 500; i++) {
      const industry = INDUSTRY_NAMES[i % INDUSTRY_NAMES.length]
      const { emissions } = generateHistoryForIndustry(industry, rng)
      const { low, high } = INDUSTRIES[industry]

      // Years 1..10 present, one decimal place
      for (let year = 1; year <= 10; year++) {
        expect(emissions[year]).toBeTypeOf('number')
        expect(emissions[year]).toBeCloseTo(Math.round(emissions[year] * 10) / 10, 10)
      }

      // The underlying latest is within the industry range; with noise (σ=3%)
      // Year_1 stays within a generous margin of it.
      expect(emissions[1]).toBeGreaterThan(low * 0.8)
      expect(emissions[1]).toBeLessThan(high * 1.2)

      // Downward trend: oldest (Year_10) = latest × (1 + U(0.05, 0.2)) net of noise
      const ratio = emissions[10] / emissions[1]
      expect(ratio).toBeGreaterThan(0.9) // noise can mask small reductions
      expect(ratio).toBeLessThan(1.45)
    }
  })
})

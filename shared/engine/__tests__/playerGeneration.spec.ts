import { describe, expect, it } from 'vitest'
import { INDUSTRIES, INDUSTRY_NAMES } from '../../constants'
import { generateHistoryForIndustry, generatePlayerProfile } from '../playerGeneration'
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
})

describe('generatePlayerProfile', () => {
  it('is deterministic for a given seed', () => {
    const a = generatePlayerProfile(createRng(42))
    const b = generatePlayerProfile(createRng(42))
    expect(a).toEqual(b)
  })

  it('produces histories consistent with the notebook formulas', () => {
    const rng = createRng(7)
    for (let i = 0; i < 500; i++) {
      const { industry, emissions } = generatePlayerProfile(rng)
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

  it('assigns industries roughly uniformly (25% each)', () => {
    const rng = createRng(123)
    const counts = new Map<string, number>(INDUSTRY_NAMES.map((n) => [n, 0]))
    const draws = 10_000
    for (let i = 0; i < draws; i++) {
      const { industry } = generatePlayerProfile(rng)
      counts.set(industry, counts.get(industry)! + 1)
    }
    for (const name of INDUSTRY_NAMES) {
      expect(counts.get(name)! / draws).toBeGreaterThan(0.2)
      expect(counts.get(name)! / draws).toBeLessThan(0.3)
    }
  })
})

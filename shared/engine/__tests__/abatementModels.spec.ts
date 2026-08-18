import { describe, expect, it } from 'vitest'
import {
  ABATEMENT_MODELS,
  bisectSpec,
  parseSpec,
  specIntegral,
  specMarginal,
  specOptimal,
  type AbatementSpec,
} from '../abatementModels'

const SPECS: AbatementSpec[] = [
  { model: 'linear', params: { a: 4, b: 20 } },
  { model: 'power', params: { a: 3, b: 25, n: 2.5 } },
  { model: 'exponential', params: { a: 3, k: 2.5 } },
  {
    model: 'tiered',
    params: {
      tiers: [
        { upTo: 0.3, rate: 5 },
        { upTo: 0.6, rate: 18 },
        { upTo: 1, rate: 60 },
      ],
    },
  },
]

/** Left-Riemann sum of the marginal curve — an independent check on each integral. */
function quadrature(spec: AbatementSpec, r: number, steps = 20000): number {
  const h = r / steps
  let sum = 0
  for (let i = 0; i < steps; i++) sum += specMarginal(i * h + h / 2, spec) * h
  return sum
}

describe.each(SPECS.map((s) => [s.model, s] as const))('%s model', (_name, spec) => {
  it('has a non-decreasing marginal curve (cheap cuts first)', () => {
    let prev = -Infinity
    for (let f = 0; f <= 1.0001; f += 0.01) {
      const m = specMarginal(f, spec)
      expect(m).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = m
    }
  })

  it('integral matches numeric quadrature of the marginal curve', () => {
    for (const r of [0.15, 0.4, 0.75, 1]) {
      expect(specIntegral(r, spec)).toBeCloseTo(quadrature(spec, r), 3)
    }
  })

  it('integral is 0 at r=0 and clamps outside [0,1]', () => {
    expect(specIntegral(0, spec)).toBe(0)
    expect(specIntegral(-1, spec)).toBe(0)
    expect(specIntegral(5, spec)).toBe(specIntegral(1, spec))
  })

  it('optimal is clamped to [0,1] and monotone in price', () => {
    let prev = -Infinity
    for (const price of [0, 1, 5, 10, 20, 50, 500]) {
      const r = specOptimal(price, spec)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      expect(r).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = r
    }
  })
})

describe('closed-form optimal agrees with the generic solver', () => {
  // Tiered is excluded: its MAC is a step function, so bisection lands on the
  // discontinuity ± ε rather than the band boundary. That is exactly why it ships
  // an exact walk instead.
  it.each(SPECS.filter((s) => s.model !== 'tiered').map((s) => [s.model, s] as const))(
    '%s',
    (_name, spec) => {
      for (const price of [0.5, 2, 4.5, 8, 13, 20, 35]) {
        expect(specOptimal(price, spec)).toBeCloseTo(bisectSpec(price, spec), 6)
      }
    },
  )
})

describe('model relationships', () => {
  it('power with n = 1 reproduces linear exactly', () => {
    const lin: AbatementSpec = { model: 'linear', params: { a: 4, b: 20 } }
    const pow: AbatementSpec = { model: 'power', params: { a: 4, b: 20, n: 1 } }
    for (const f of [0, 0.25, 0.5, 0.9, 1]) {
      expect(specMarginal(f, pow)).toBeCloseTo(specMarginal(f, lin), 12)
      expect(specIntegral(f, pow)).toBeCloseTo(specIntegral(f, lin), 12)
    }
    for (const p of [1, 6, 12, 30]) {
      expect(specOptimal(p, pow)).toBeCloseTo(specOptimal(p, lin), 12)
    }
  })

  it('exponential degenerates to a·r as k → 0, without dividing by zero', () => {
    const flat: AbatementSpec = { model: 'exponential', params: { a: 7, k: 0 } }
    expect(specIntegral(1, flat)).toBeCloseTo(7, 12)
    expect(specIntegral(0.5, flat)).toBeCloseTo(3.5, 12)
    expect(Number.isFinite(specIntegral(1, flat))).toBe(true)

    const tiny: AbatementSpec = { model: 'exponential', params: { a: 7, k: 1e-12 } }
    expect(specIntegral(1, tiny)).toBeCloseTo(7, 9)
  })

  it('exponential back-loads the expense — cheap shallow cuts, a punishing last tonne', () => {
    const lin: AbatementSpec = { model: 'linear', params: { a: 3, b: 20 } }
    const exp: AbatementSpec = { model: 'exponential', params: { a: 3, k: 2.5 } }

    // Roughly the same total cost to run all the way to 100% (13.0 vs 13.4)…
    expect(specIntegral(1, exp)).toBeCloseTo(specIntegral(1, lin), 0)
    // …so the difference is shape, not scale. The two marginal curves CROSS near
    // f ≈ 0.7: exponential is the cheaper way to make a small cut and much the dearer
    // way to make a deep one.
    expect(specMarginal(0.3, exp)).toBeLessThan(specMarginal(0.3, lin))
    expect(specMarginal(0.9, exp)).toBeGreaterThan(specMarginal(0.9, lin))
    expect(specMarginal(1, exp)).toBeGreaterThan(specMarginal(1, lin) * 1.5)

    // Which is what matters for the market: above the crossover — where a tight cap
    // puts the price — the exponential firm cuts less and buys more allowances.
    for (const price of [18, 20, 25]) {
      expect(specOptimal(price, exp)).toBeLessThan(specOptimal(price, lin))
    }
    // Below it the ordering reverses, so a scenario must not assume one dominates.
    expect(specOptimal(8, exp)).toBeGreaterThan(specOptimal(8, lin))
  })

  it('tiered puts the optimum on a band boundary, never between', () => {
    const spec = SPECS[3]
    expect(specOptimal(4, spec)).toBe(0) // below the cheapest band
    expect(specOptimal(5, spec)).toBe(0.3) // first band affordable
    expect(specOptimal(17, spec)).toBe(0.3)
    expect(specOptimal(18, spec)).toBe(0.6)
    expect(specOptimal(100, spec)).toBe(1)
  })
})

describe('parseSpec validation', () => {
  it('accepts each shipped model with its defaults', () => {
    for (const [id, model] of Object.entries(ABATEMENT_MODELS)) {
      expect(parseSpec({ model: id, params: model.defaults })).toEqual({
        model: id,
        params: model.defaults,
      })
    }
  })

  it('rejects unknown models and malformed params', () => {
    expect(() => parseSpec({ model: 'quadratic', params: {} })).toThrow(/unknown model/)
    expect(() => parseSpec({ model: 'linear', params: { a: 1 } })).toThrow(/b must be/)
    expect(() => parseSpec({ model: 'linear', params: { a: -1, b: 2 } })).toThrow(/a must be/)
  })

  it('enforces the tiered contract: ascending bands, non-decreasing rates, ends at 1', () => {
    const t = (tiers: unknown) => () => parseSpec({ model: 'tiered', params: { tiers } })
    expect(t([])).toThrow(/non-empty/)
    expect(t([{ upTo: 0.5, rate: 5 }])).toThrow(/last tier must have upTo === 1/)
    expect(t([{ upTo: 0.6, rate: 5 }, { upTo: 0.3, rate: 9 }])).toThrow(/must ascend/)
    // A decreasing rate would break the "cheap cuts first" invariant every caller assumes.
    expect(t([{ upTo: 0.5, rate: 9 }, { upTo: 1, rate: 4 }])).toThrow(/must not decrease/)
    expect(t([{ upTo: 0.5, rate: 4 }, { upTo: 1, rate: 9 }])).not.toThrow()
  })
})

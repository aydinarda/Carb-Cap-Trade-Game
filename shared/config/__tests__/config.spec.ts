import { describe, expect, it } from 'vitest'
import {
  BENCHMARK_STRINGENCY,
  DEFAULT_ABATEMENT,
  DEFAULT_BENCHMARK,
  INDUSTRIES,
  INDUSTRY_NAMES,
} from '../../constants'
import { DEFAULT_GAME_CONFIG, deepMerge, resolveConfig } from '../index'

describe('DEFAULT_GAME_CONFIG reproduces the shipped constants', () => {
  it('carries the values the engine used before the refactor', () => {
    const c = DEFAULT_GAME_CONFIG
    expect(c.market.penaltyRate).toBe(20)
    expect(c.market.openingReferenceFraction).toBe(0.5) // was the literal penaltyRate / 2
    expect(c.allocation.freeCreditRatio).toBe(0.8)
    expect(c.allocation.auctionCapRatio).toBe(1)
    expect(c.allocation.capReductionFactor).toBe(0.97)
    expect(c.allocation.applyLRFToGrandfathering).toBe(false) // preserves today's asymmetry
    expect(c.emissions.volatility).toBe(0.08)
    expect(c.emissions.historyWindow).toBe(10)
    expect(c.emissions.baselineYear).toBe(10)
    expect(c.emissions.firstGameYear).toBe(11)
    expect(c.session.maxPlayers).toBe(60)
    expect(c.bots.maxStep).toBe(40)
    expect(c.bots.marketMaker.invFrac).toBe(0.18)
    expect(c.bots.seed.marketMakerFrac).toBe(0.18)
  })

  it('derives the sector tables from constants rather than restating them', () => {
    expect(DEFAULT_GAME_CONFIG.allocation.benchmark).toEqual(DEFAULT_BENCHMARK)
    expect(DEFAULT_GAME_CONFIG.allocation.benchmarkStringency).toBe(BENCHMARK_STRINGENCY)
    for (const i of INDUSTRY_NAMES) {
      expect(DEFAULT_GAME_CONFIG.emissions.industries[i]).toEqual({ ...INDUSTRIES[i] })
      expect(DEFAULT_GAME_CONFIG.abatement.sectors[i]).toEqual({
        model: 'linear',
        params: DEFAULT_ABATEMENT[i],
      })
    }
  })
})

describe('deepMerge', () => {
  it('merges Record<Industry, …> key by key, leaving the other sectors alone', () => {
    const c = resolveConfig({ allocation: { benchmark: { Transport: 42 } } })
    expect(c.allocation.benchmark.Transport).toBe(42)
    expect(c.allocation.benchmark['Power & Utilities']).toBe(
      DEFAULT_BENCHMARK['Power & Utilities'],
    )
  })

  it('replaces arrays wholesale instead of merging element-wise', () => {
    const c = resolveConfig({
      abatement: {
        sectors: {
          Transport: { model: 'tiered', params: { tiers: [{ upTo: 1, rate: 7 }] } },
        },
      },
    })
    const spec = c.abatement.sectors.Transport
    expect(spec.model).toBe('tiered')
    // A 1-band override must not inherit bands 2 and 3 from the model defaults.
    expect(spec.model === 'tiered' && spec.params.tiers).toEqual([{ upTo: 1, rate: 7 }])
  })

  it('never mutates the base — the aliasing bug that would leak host edits between rooms', () => {
    const a = resolveConfig()
    const b = resolveConfig()

    a.allocation.benchmark.Transport = 999
    a.bots.sigma.noise = 9
    a.emissions.industries.Transport.low = 1
    a.abatement.sectors.Transport = { model: 'exponential', params: { a: 1, k: 1 } }

    expect(b.allocation.benchmark.Transport).toBe(DEFAULT_BENCHMARK.Transport)
    expect(b.bots.sigma.noise).toBe(0.2)
    expect(b.emissions.industries.Transport.low).toBe(INDUSTRIES.Transport.low)
    expect(b.abatement.sectors.Transport.model).toBe('linear')
    // …and the module default itself is untouched.
    expect(DEFAULT_GAME_CONFIG.allocation.benchmark.Transport).toBe(DEFAULT_BENCHMARK.Transport)
    expect(DEFAULT_GAME_CONFIG.bots.sigma.noise).toBe(0.2)
  })

  it('treats undefined as "leave it alone"', () => {
    const c = deepMerge(DEFAULT_GAME_CONFIG, { market: { penaltyRate: undefined } })
    expect(c.market.penaltyRate).toBe(20)
  })
})

describe('resolveConfig — abatement model swaps', () => {
  it('does not inherit the replaced model’s params', () => {
    // Without the normalization pass this yields {model:'exponential', params:{a,b}},
    // whose NaN costs would flow through settlement into every score.
    const c = resolveConfig({ abatement: { sectors: { Transport: { model: 'exponential' } } } })
    const spec = c.abatement.sectors.Transport
    expect(spec.model).toBe('exponential')
    expect(spec.params).not.toHaveProperty('b')
    expect(spec.params).toHaveProperty('k')
  })

  it('accepts an explicit model + params pair', () => {
    const c = resolveConfig({
      abatement: { sectors: { 'Heavy Materials': { model: 'power', params: { a: 1, b: 9, n: 3 } } } },
    })
    expect(c.abatement.sectors['Heavy Materials']).toEqual({
      model: 'power',
      params: { a: 1, b: 9, n: 3 },
    })
  })

  it('rejects a malformed spec rather than silently producing NaN later', () => {
    expect(() =>
      resolveConfig({
        abatement: { sectors: { Transport: { model: 'power', params: { a: 1, b: 2 } } } },
      }),
    ).toThrow(/n must be/)
  })
})

describe('validateConfig', () => {
  it('rejects out-of-range values', () => {
    expect(() => resolveConfig({ market: { penaltyRate: -1 } })).toThrow(/penaltyRate/)
    expect(() => resolveConfig({ allocation: { capReductionFactor: 0 } })).toThrow(/\(0, 1]/)
    expect(() => resolveConfig({ allocation: { capReductionFactor: 1.5 } })).toThrow(/\(0, 1]/)
    expect(() => resolveConfig({ session: { maxPlayers: 0 } })).toThrow(/maxPlayers/)
    expect(() =>
      resolveConfig({ emissions: { industries: { Transport: { low: 500, high: 100 } } } }),
    ).toThrow(/low <= high/)
  })

  it('accepts an LRF of exactly 1 (a flat cap)', () => {
    expect(resolveConfig({ allocation: { capReductionFactor: 1 } }).allocation.capReductionFactor)
      .toBe(1)
  })
})

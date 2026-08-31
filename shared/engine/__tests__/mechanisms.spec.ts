import { describe, expect, it } from 'vitest'
import {
  BENCHMARK_STRINGENCY,
  DEFAULT_BENCHMARK,
  INDUSTRY_NAMES,
  SECTOR_AVERAGE_EMISSIONS,
} from '../../constants'
import type { Player } from '../../types'
import { CAP_MECHANISMS } from '../index'
import { resolveConfig } from '../../config'
import { DEFAULT_CONFIG, XLSX_PLAYERS } from './fixtures'

const players = XLSX_PLAYERS.map((f) => f.player)

/** A pure-trader bot: a financial player with no activity level to benchmark. */
function traderBot(id: string): Player {
  return {
    id,
    name: id,
    industry: 'Power & Utilities',
    emissions: { 10: 0.1 },
    connected: true,
    score: 0,
    optimalScore: 0,
    investmentGapTotal: 0,
    bankedCredits: 0,
    abatementInForce: 0,
    abatementCommitted: 0,
    abatementEmbedded: 0,
    isBot: true,
    botType: 'marketMaker',
  }
}

describe('cap mechanism registry', () => {
  it('exposes all four modes, all implemented', () => {
    expect(Object.keys(CAP_MECHANISMS).sort()).toEqual([
      'auctioning',
      'benchmarking',
      'grandfathering',
      'hybrid',
    ])
    for (const mode of Object.values(CAP_MECHANISMS)) {
      expect(mode.implemented).toBe(true)
    }
  })

  it('the auction-bearing modes are auctioning and hybrid', () => {
    expect(CAP_MECHANISMS.auctioning.usesAuction).toBe(true)
    expect(CAP_MECHANISMS.hybrid.usesAuction).toBe(true)
    expect(CAP_MECHANISMS.benchmarking.usesAuction).toBe(false)
    expect(CAP_MECHANISMS.grandfathering.usesAuction).toBe(false)
  })

  // The views gate the sector-benchmark fields on this rather than on the mode name.
  it('declares what its free allocation is derived from', () => {
    expect(CAP_MECHANISMS.grandfathering.freeAllocation).toBe('history')
    expect(CAP_MECHANISMS.benchmarking.freeAllocation).toBe('benchmark')
    expect(CAP_MECHANISMS.hybrid.freeAllocation).toBe('benchmark')
    expect(CAP_MECHANISMS.auctioning.freeAllocation).toBe('none')
  })

  it('only the auction-bearing modes offer a primary supply', () => {
    const baseline = 28332.7
    for (const mode of ['benchmarking', 'grandfathering'] as const) {
      expect(CAP_MECHANISMS[mode].poolFor(players, 11, DEFAULT_CONFIG, baseline)).toBe(0)
    }
    // ratio × baseline × LRF^0 — the ratio read from the config, since it is calibrated.
    expect(CAP_MECHANISMS.auctioning.poolFor(players, 11, DEFAULT_CONFIG, baseline)).toBe(
      Math.round(baseline * DEFAULT_CONFIG.allocation.auctionCapRatio * 10) / 10,
    )
    expect(
      CAP_MECHANISMS.hybrid.poolFor(players, 11, DEFAULT_CONFIG, baseline),
    ).toBeGreaterThan(0)
  })
})

describe('default benchmarks', () => {
  // The table is the sector average scaled by the shipped level and rounded to 1dp. The
  // LEVEL is calibration and moves; the derivation is the invariant, so that is what is
  // asserted. (It has been both below and above 1.0 — see BENCHMARK_STRINGENCY.)
  it('are the sector average scaled by the shipped level', () => {
    for (const industry of INDUSTRY_NAMES) {
      expect(DEFAULT_BENCHMARK[industry]).toBeCloseTo(
        Math.round(SECTOR_AVERAGE_EMISSIONS[industry] * BENCHMARK_STRINGENCY * 10) / 10,
        6,
      )
    }
  })
})

describe('benchmarking', () => {
  it('gives every company its sector benchmark, regardless of history', () => {
    const allocation = CAP_MECHANISMS.benchmarking.allocate(players, 11, 0, DEFAULT_CONFIG)
    for (const p of players) {
      expect(allocation[p.id]).toBe(DEFAULT_CONFIG.allocation.benchmark[p.industry])
    }
  })

  it('free credit limit is the sum of per-company benchmarks', () => {
    const expected = players.reduce((s, p) => s + DEFAULT_CONFIG.allocation.benchmark[p.industry], 0)
    expect(CAP_MECHANISMS.benchmarking.computeFreeCreditLimit(players, DEFAULT_CONFIG)).toBe(
      expected,
    )
  })

  it('tightens each year by the cap reduction factor', () => {
    const config = resolveConfig({ allocation: { capReductionFactor: 0.97 } })
    const [p] = players
    const base = config.allocation.benchmark[p.industry]
    for (const year of [11, 12, 13]) {
      const allocation = CAP_MECHANISMS.benchmarking.allocate([p], year, 0, config)
      const expected = Math.round(base * Math.pow(0.97, year - 11) * 10) / 10
      expect(allocation[p.id]).toBe(expected)
    }
  })

  it('gives pure-trader bots nothing — they have no activity level', () => {
    const bot = traderBot('B1')
    const allocation = CAP_MECHANISMS.benchmarking.allocate([...players, bot], 11, 0, DEFAULT_CONFIG)
    expect(allocation[bot.id]).toBe(0)
    // …and they do not inflate the class limit either.
    expect(
      CAP_MECHANISMS.benchmarking.computeFreeCreditLimit([...players, bot], DEFAULT_CONFIG),
    ).toBe(CAP_MECHANISMS.benchmarking.computeFreeCreditLimit(players, DEFAULT_CONFIG))
  })

  it('prices regulatorGranted at the reference (the trader-bot seed)', () => {
    const record = { auctionPrice: null } as never
    // Both free-allocation modes sell the trader bots their opening book at the
    // reference price — nothing else ever lands in regulatorGranted under either.
    expect(CAP_MECHANISMS.benchmarking.primaryPrice(record, DEFAULT_CONFIG, 12.4)).toBe(12.4)
    expect(CAP_MECHANISMS.grandfathering.primaryPrice(record, DEFAULT_CONFIG, 12.4)).toBe(12.4)
  })
})

/**
 * Hybrid: a share of the sector benchmark free, and the REST OF THE CAP auctioned.
 *
 * The identity every case here circles is `free + pool === cap`: the shares decide who is
 * handed allowances and who has to bid for them, and they must not be able to change how
 * many exist. That is the whole claim the mode makes to a class.
 */
describe('hybrid', () => {
  const BASELINE = 28332.7
  /** The class's total issuance for a year — what has to stay pinned to the cap. */
  const issued = (config: typeof DEFAULT_CONFIG, year: number, ps = players) =>
    Math.round(
      (Object.values(CAP_MECHANISMS.hybrid.allocate(ps, year, 0, config)).reduce(
        (a, b) => a + b,
        0,
      ) +
        CAP_MECHANISMS.hybrid.poolFor(ps, year, config, BASELINE)) *
        10,
    ) / 10
  const capFor = (config: typeof DEFAULT_CONFIG, year: number) =>
    config.allocation.auctionCapRatio * BASELINE * Math.pow(config.allocation.capReductionFactor, year - 11)

  /** Flat LRF (not the shipped decelerating schedule) so a year's cap is one power. */
  const flat = (share: Partial<Record<(typeof players)[number]['industry'], number>>) =>
    resolveConfig({
      allocation: {
        capReductionFactor: 0.97,
        capReductionSchedule: [],
        hybridFreeShare: share,
      },
    })

  it('issues share × the sector benchmark, and nothing to an excluded sector', () => {
    const config = flat({ 'Power & Utilities': 0, 'Heavy Materials': 1, Transport: 0.5 })
    const allocation = CAP_MECHANISMS.hybrid.allocate(players, 11, 0, config)
    for (const p of players) {
      const share = config.allocation.hybridFreeShare[p.industry]
      expect(allocation[p.id]).toBe(
        Math.round(config.allocation.benchmark[p.industry] * share * 10) / 10,
      )
    }
    // The exclusion is the headline behaviour: a 0 share means literally nothing free.
    for (const p of players.filter((x) => x.industry === 'Power & Utilities')) {
      expect(allocation[p.id]).toBe(0)
    }
  })

  it('the auction sells the residual, so free + pool is the cap however the shares move', () => {
    const generous = flat({
      'Power & Utilities': 1,
      'Heavy Materials': 1,
      'Manufacturing & Chemicals': 0.5,
      Transport: 0.5,
    })
    const stingy = flat({
      'Power & Utilities': 0,
      'Heavy Materials': 0.1,
      'Manufacturing & Chemicals': 0,
      Transport: 0,
    })
    // Wildly different distributions, one cap. Free allocation is deducted from the pool,
    // never added on top of it — the property the whole mode rests on.
    expect(issued(generous, 11)).toBeCloseTo(capFor(generous, 11), 0)
    expect(issued(stingy, 11)).toBeCloseTo(capFor(stingy, 11), 0)
    // …and the generous table really did shrink the auction rather than just relabel it.
    expect(CAP_MECHANISMS.hybrid.poolFor(players, 11, generous, BASELINE)).toBeLessThan(
      CAP_MECHANISMS.hybrid.poolFor(players, 11, stingy, BASELINE),
    )
  })

  it('tightens both halves each year by the cap reduction factor', () => {
    const config = flat({
      'Power & Utilities': 0,
      'Heavy Materials': 1,
      'Manufacturing & Chemicals': 0.8,
      Transport: 0.3,
    })
    const [p] = players
    const share = config.allocation.hybridFreeShare[p.industry]
    for (const year of [11, 12, 13]) {
      const allocation = CAP_MECHANISMS.hybrid.allocate([p], year, 0, config)
      const benchmark = Math.round(
        config.allocation.benchmark[p.industry] * Math.pow(0.97, year - 11) * 10,
      ) / 10
      expect(allocation[p.id]).toBe(Math.round(benchmark * share * 10) / 10)
      // The cap falls with it, so the identity holds in every year, not just the first.
      expect(issued(config, year)).toBeCloseTo(capFor(config, year), 0)
    }
  })

  it('clamps the pool at zero when the shares exhaust the cap', () => {
    // Every sector at its full benchmark, against a cap ratio small enough that the free
    // allocation alone overruns it. The mode degenerates to benchmarking rather than
    // reporting a negative supply.
    const config = resolveConfig({
      allocation: {
        auctionCapRatio: 0.05,
        hybridFreeShare: {
          'Power & Utilities': 1,
          'Heavy Materials': 1,
          'Manufacturing & Chemicals': 1,
          Transport: 1,
        },
      },
    })
    expect(CAP_MECHANISMS.hybrid.poolFor(players, 11, config, BASELINE)).toBe(0)
  })

  it('gives pure-trader bots nothing and does not let them shrink the auction', () => {
    const bot = traderBot('B1')
    const allocation = CAP_MECHANISMS.hybrid.allocate([...players, bot], 11, 0, DEFAULT_CONFIG)
    expect(allocation[bot.id]).toBe(0)
    expect(
      CAP_MECHANISMS.hybrid.computeFreeCreditLimit([...players, bot], DEFAULT_CONFIG),
    ).toBe(CAP_MECHANISMS.hybrid.computeFreeCreditLimit(players, DEFAULT_CONFIG))
    // A trader drawing free credits would have taken them out of the pool everyone bids in.
    expect(CAP_MECHANISMS.hybrid.poolFor([...players, bot], 11, DEFAULT_CONFIG, BASELINE)).toBe(
      CAP_MECHANISMS.hybrid.poolFor(players, 11, DEFAULT_CONFIG, BASELINE),
    )
  })

  it('charges the auction clearing price for what was won there', () => {
    // The free allocation never lands in `regulatorGranted`, so this price only ever
    // applies to auctioned credits — which is what keeps the free half free.
    expect(CAP_MECHANISMS.hybrid.primaryPrice({ auctionPrice: 31.5 } as never, DEFAULT_CONFIG, 12.4)).toBe(31.5)
    expect(CAP_MECHANISMS.hybrid.primaryPrice({ auctionPrice: null } as never, DEFAULT_CONFIG, 12.4)).toBe(0)
  })
})

/**
 * Does abating this year cut next year's free allocation? Under benchmarking it must not —
 * that is the whole point of an ex-ante benchmark, and a ratchet would tell students the
 * profitable move is to keep emitting. Under grandfathering it must, because the allocation
 * is a share of a moving window of your own realized emissions.
 *
 * Both cases go through the same setup a real year end produces: `Session.realizeYear` writes
 * the post-abatement emission into `player.emissions[year]`, and that year then enters the
 * grandfathering window.
 */
describe('abatement feedback into the next year’s allocation', () => {
  /** What year end leaves behind: Year 11 realized at `fraction` of the baseline year. */
  function realizedYear11(p: Player, fraction: number): Player {
    return { ...p, emissions: { ...p.emissions, 11: (p.emissions[10] ?? 0) * fraction } }
  }

  const flat = players.map((p) => realizedYear11(p, 1)) // nobody abates
  const p1Abates = [realizedYear11(players[0], 0.5), ...flat.slice(1)] // P1 halves its emissions

  it('benchmarking: halving your emissions leaves next year’s free credits untouched', () => {
    const before = CAP_MECHANISMS.benchmarking.allocate(flat, 12, 0, DEFAULT_CONFIG)
    const after = CAP_MECHANISMS.benchmarking.allocate(p1Abates, 12, 0, DEFAULT_CONFIG)
    expect(after[players[0].id]).toBe(before[players[0].id])
    // …and it does not quietly move anyone else's either, since nothing is shared out.
    expect(after).toEqual(before)
  })

  it('benchmarking: the whole class abating still leaves every allocation untouched', () => {
    const allAbate = players.map((p) => realizedYear11(p, 0.5))
    expect(CAP_MECHANISMS.benchmarking.allocate(allAbate, 12, 0, DEFAULT_CONFIG)).toEqual(
      CAP_MECHANISMS.benchmarking.allocate(flat, 12, 0, DEFAULT_CONFIG),
    )
  })

  it('grandfathering: the same cut does shrink next year’s share — the ratchet benchmarking removes', () => {
    // The class limit is fixed off the baseline year, so only the shares move.
    const limit = CAP_MECHANISMS.grandfathering.computeFreeCreditLimit(flat, DEFAULT_CONFIG)
    const before = CAP_MECHANISMS.grandfathering.allocate(flat, 12, limit, DEFAULT_CONFIG)
    const after = CAP_MECHANISMS.grandfathering.allocate(p1Abates, 12, limit, DEFAULT_CONFIG)
    expect(after[players[0].id]).toBeLessThan(before[players[0].id])
    // The forgone share is handed to the companies that did not cut.
    expect(after[players[1].id]).toBeGreaterThan(before[players[1].id])
  })
})

describe('auctioning', () => {
  it('allocates zero free credits to everyone', () => {
    const allocation = CAP_MECHANISMS.auctioning.allocate(players, 11, 0, DEFAULT_CONFIG)
    for (const p of players) expect(allocation[p.id]).toBe(0)
    expect(CAP_MECHANISMS.auctioning.computeFreeCreditLimit(players, DEFAULT_CONFIG)).toBe(0)
  })

  it('shrinks the supply by the reduction factor each year', () => {
    // Ratio pinned too, so this measures the LRF alone rather than the shipped supply level.
    const config = resolveConfig({
      allocation: { capReductionFactor: 0.9, auctionCapRatio: 1 },
    })
    expect(CAP_MECHANISMS.auctioning.poolFor(players, 12, config, 1000)).toBe(900)
    expect(CAP_MECHANISMS.auctioning.poolFor(players, 13, config, 1000)).toBe(810)
  })

  it('prices regulatorGranted at the clearing price', () => {
    expect(
      CAP_MECHANISMS.auctioning.primaryPrice({ auctionPrice: 14.2 } as never, DEFAULT_CONFIG, 9),
    ).toBe(14.2)
  })
})

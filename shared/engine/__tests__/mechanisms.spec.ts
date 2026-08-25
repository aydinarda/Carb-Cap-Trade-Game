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
    bankedCredits: 0,
    abatementInForce: 0,
    abatementCommitted: 0,
    abatementEmbedded: 0,
    isBot: true,
    botType: 'marketMaker',
  }
}

describe('cap mechanism registry', () => {
  it('exposes all three modes, all implemented', () => {
    expect(Object.keys(CAP_MECHANISMS).sort()).toEqual([
      'auctioning',
      'benchmarking',
      'grandfathering',
    ])
    for (const mode of Object.values(CAP_MECHANISMS)) {
      expect(mode.implemented).toBe(true)
    }
  })

  it('only auctioning runs a cap-stage auction', () => {
    expect(CAP_MECHANISMS.auctioning.usesAuction).toBe(true)
    expect(CAP_MECHANISMS.benchmarking.usesAuction).toBe(false)
    expect(CAP_MECHANISMS.grandfathering.usesAuction).toBe(false)
  })

  it('only auctioning offers a primary supply', () => {
    for (const mode of ['benchmarking', 'grandfathering'] as const) {
      expect(CAP_MECHANISMS[mode].poolFor(players, 11, DEFAULT_CONFIG, 28332.7)).toBe(0)
    }
    // ratio 1.0 × baseline × 0.97^0
    expect(CAP_MECHANISMS.auctioning.poolFor(players, 11, DEFAULT_CONFIG, 28332.7)).toBe(28332.7)
  })
})

describe('default benchmarks', () => {
  it('sit 40% below each sector average', () => {
    for (const industry of INDUSTRY_NAMES) {
      expect(DEFAULT_BENCHMARK[industry]).toBeCloseTo(
        SECTOR_AVERAGE_EMISSIONS[industry] * BENCHMARK_STRINGENCY,
        6,
      )
    }
    expect(DEFAULT_BENCHMARK).toEqual({
      'Power & Utilities': 600,
      'Heavy Materials': 480,
      'Manufacturing & Chemicals': 315,
      Transport: 180,
    })
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

describe('auctioning', () => {
  it('allocates zero free credits to everyone', () => {
    const allocation = CAP_MECHANISMS.auctioning.allocate(players, 11, 0, DEFAULT_CONFIG)
    for (const p of players) expect(allocation[p.id]).toBe(0)
    expect(CAP_MECHANISMS.auctioning.computeFreeCreditLimit(players, DEFAULT_CONFIG)).toBe(0)
  })

  it('shrinks the supply by the reduction factor each year', () => {
    const config = resolveConfig({ allocation: { capReductionFactor: 0.9 } })
    expect(CAP_MECHANISMS.auctioning.poolFor(players, 12, config, 1000)).toBe(900)
    expect(CAP_MECHANISMS.auctioning.poolFor(players, 13, config, 1000)).toBe(810)
  })

  it('prices regulatorGranted at the clearing price', () => {
    expect(
      CAP_MECHANISMS.auctioning.primaryPrice({ auctionPrice: 14.2 } as never, DEFAULT_CONFIG, 9),
    ).toBe(14.2)
  })
})

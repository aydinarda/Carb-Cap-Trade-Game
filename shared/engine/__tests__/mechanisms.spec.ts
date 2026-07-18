import { describe, expect, it } from 'vitest'
import { CAP_MECHANISMS } from '../index'
import { DEFAULT_CONFIG, XLSX_PLAYERS } from './fixtures'

const players = XLSX_PLAYERS.map((f) => f.player)

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
})

describe('benchmarking', () => {
  it('gives every company its industry benchmark, regardless of history', () => {
    const allocation = CAP_MECHANISMS.benchmarking.allocate(players, 11, 0, DEFAULT_CONFIG)
    for (const p of players) {
      expect(allocation[p.id]).toBe(DEFAULT_CONFIG.benchmark[p.industry])
    }
  })

  it('free credit limit is the sum of per-company benchmarks', () => {
    const expected = players.reduce((s, p) => s + DEFAULT_CONFIG.benchmark[p.industry], 0)
    expect(CAP_MECHANISMS.benchmarking.computeFreeCreditLimit(players, DEFAULT_CONFIG)).toBe(
      expected,
    )
  })
})

describe('auctioning', () => {
  it('allocates zero free credits to everyone', () => {
    const allocation = CAP_MECHANISMS.auctioning.allocate(players, 11, 0, DEFAULT_CONFIG)
    for (const p of players) expect(allocation[p.id]).toBe(0)
    expect(CAP_MECHANISMS.auctioning.computeFreeCreditLimit(players, DEFAULT_CONFIG)).toBe(0)
  })
})

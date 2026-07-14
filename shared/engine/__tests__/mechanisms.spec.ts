import { describe, expect, it } from 'vitest'
import { CAP_MECHANISMS, MechanismNotImplementedError } from '../index'
import { DEFAULT_CONFIG, XLSX_PLAYERS } from './fixtures'

describe('cap mechanism registry', () => {
  it('exposes all three modes', () => {
    expect(Object.keys(CAP_MECHANISMS).sort()).toEqual([
      'auctioning',
      'benchmarking',
      'grandfathering',
    ])
  })

  it('only grandfathering is implemented; stubs throw MechanismNotImplementedError', () => {
    expect(CAP_MECHANISMS.grandfathering.implemented).toBe(true)
    const players = XLSX_PLAYERS.map((f) => f.player)
    for (const mode of ['benchmarking', 'auctioning'] as const) {
      const mechanism = CAP_MECHANISMS[mode]
      expect(mechanism.implemented).toBe(false)
      expect(() => mechanism.allocate(players, 11, 1000, DEFAULT_CONFIG)).toThrowError(
        MechanismNotImplementedError,
      )
    }
  })
})

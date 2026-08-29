import { describe, expect, it } from 'vitest'
import { computeFreeCreditLimit, grandfathering, windowSum } from '../grandfathering'
import { round1 } from '../rng'
import { DEFAULT_CONFIG, XLSX_CLASS_TOTALS, XLSX_PLAYERS } from './fixtures'

describe('windowSum', () => {
  it('reproduces the notebook "past ten-year emissions" column exactly', () => {
    for (const { player, pastTenYears } of XLSX_PLAYERS) {
      expect(round1(windowSum(player, 11, 10))).toBe(pastTenYears)
    }
  })

  it('moves the window: for Year 12 it includes realized Year 11 and drops Year 1', () => {
    const { player } = XLSX_PLAYERS[0]
    const withRealized = {
      ...player,
      emissions: { ...player.emissions, 11: 309.4 },
    }
    const expected = windowSum(player, 11, 10) - player.emissions[1] + 309.4
    expect(windowSum(withRealized, 12, 10)).toBeCloseTo(expected, 6)
  })
})

describe('computeFreeCreditLimit', () => {
  // Derived from the config, not from the number that happens to ship: the ratio is a
  // calibration knob and has already moved once (0.8 → 1.0). What must hold is the RULE.
  it('is freeCreditRatio × Σ baseline-year emissions', () => {
    const players = XLSX_PLAYERS.map((f) => f.player)
    const totalBaseline = players.reduce((s, p) => s + p.emissions[10], 0)
    expect(computeFreeCreditLimit(players, DEFAULT_CONFIG)).toBeCloseTo(
      totalBaseline * DEFAULT_CONFIG.allocation.freeCreditRatio,
      6,
    )
  })
})

describe('grandfathering.allocate', () => {
  it('reproduces the designer xlsx allocations given the published class totals', () => {
    // Allocation formula applied with the full-class totals from the xlsx.
    const { freeCreditLimit, totalPastTenYears } = XLSX_CLASS_TOTALS
    for (const { pastTenYears, expectedAllocation } of XLSX_PLAYERS) {
      expect(round1((pastTenYears / totalPastTenYears) * freeCreditLimit)).toBe(
        expectedAllocation,
      )
    }
  })

  it('allocates proportionally to window sums and sums to the limit', () => {
    const players = XLSX_PLAYERS.map((f) => f.player)
    const limit = computeFreeCreditLimit(players, DEFAULT_CONFIG)
    const allocation = grandfathering.allocate(players, 11, limit, DEFAULT_CONFIG)

    const totalPast = players.reduce((s, p) => s + windowSum(p, 11, 10), 0)
    for (const p of players) {
      expect(allocation[p.id]).toBe(round1((windowSum(p, 11, 10) / totalPast) * limit))
    }
    const totalAllocated = Object.values(allocation).reduce((a, b) => a + b, 0)
    expect(Math.abs(totalAllocated - limit)).toBeLessThan(0.05 * players.length)
  })

  it('handles an all-zero history without dividing by zero', () => {
    const players = XLSX_PLAYERS.map((f) => ({
      ...f.player,
      emissions: Object.fromEntries(Object.keys(f.player.emissions).map((y) => [y, 0])),
    }))
    const allocation = grandfathering.allocate(players, 11, 100, DEFAULT_CONFIG)
    for (const p of players) expect(allocation[p.id]).toBe(0)
  })
})

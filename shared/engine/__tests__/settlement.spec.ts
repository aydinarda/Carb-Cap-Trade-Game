import { describe, expect, it } from 'vitest'
import { settleYear } from '../settlement'

const rates = { lowPenaltyRate: 1, highPenaltyRate: 3 }

describe('settleYear', () => {
  it('applies no penalty when everyone is covered', () => {
    const { settlement, leftoverDistributed } = settleYear(
      { P1: 100, P2: 200 },
      { P1: 120, P2: 200 },
      50,
      rates,
    )
    expect(settlement.P1).toEqual({ shortage: 0, coveredByLeftover: 0, penalty: 0 })
    expect(settlement.P2.penalty).toBe(0)
    expect(leftoverDistributed).toBe(0)
  })

  it('covers the whole shortage at the low rate when leftovers suffice', () => {
    const { settlement } = settleYear({ P1: 100 }, { P1: 60 }, 100, rates)
    expect(settlement.P1).toEqual({ shortage: 40, coveredByLeftover: 40, penalty: 40 })
  })

  it('charges the high rate for shortage beyond the leftover pool', () => {
    const { settlement } = settleYear({ P1: 100 }, { P1: 60 }, 0, rates)
    expect(settlement.P1).toEqual({ shortage: 40, coveredByLeftover: 0, penalty: 120 })
  })

  it('distributes a scarce leftover pool pro-rata across shorts', () => {
    const { settlement, leftoverDistributed } = settleYear(
      { P1: 100, P2: 100, P3: 100 },
      { P1: 70, P2: 90, P3: 100 }, // shortages: 30, 10, 0
      20,
      rates,
    )
    expect(settlement.P1.coveredByLeftover).toBe(15) // 30/40 × 20
    expect(settlement.P2.coveredByLeftover).toBe(5) // 10/40 × 20
    expect(settlement.P3.penalty).toBe(0)
    // P1: 15×1 + 15×3 = 60 ; P2: 5×1 + 5×3 = 20
    expect(settlement.P1.penalty).toBe(60)
    expect(settlement.P2.penalty).toBe(20)
    expect(leftoverDistributed).toBe(20)
  })
})

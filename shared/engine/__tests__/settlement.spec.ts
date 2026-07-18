import { describe, expect, it } from 'vitest'
import { settleYear } from '../settlement'

const rates = { regulatorPrice: 10, penaltyRate: 20 }

describe('settleYear (cost ledger)', () => {
  it('charges only the purchase cost when fully covered', () => {
    const { settlement } = settleYear(
      { P1: 100, P2: 200 },
      { P1: 120, P2: 200 }, // held ≥ realized → no shortage
      { P1: 40, P2: 0 }, // P1 bought 40 credits
      rates,
    )
    expect(settlement.P1).toEqual({
      shortage: 0,
      purchaseCost: 400, // 40 × 10
      penaltyCost: 0,
      yearCost: 400,
    })
    expect(settlement.P2).toEqual({
      shortage: 0,
      purchaseCost: 0,
      penaltyCost: 0,
      yearCost: 0,
    })
  })

  it('charges the penalty rate for uncovered shortage', () => {
    const { settlement } = settleYear({ P1: 100 }, { P1: 60 }, { P1: 0 }, rates)
    // shortage 40 → penalty 40 × 20 = 800, no purchases
    expect(settlement.P1).toEqual({
      shortage: 40,
      purchaseCost: 0,
      penaltyCost: 800,
      yearCost: 800,
    })
  })

  it('sums purchase and penalty into the year cost', () => {
    const { settlement } = settleYear({ P1: 100 }, { P1: 90 }, { P1: 30 }, rates)
    // bought 30 (cost 300); shortage 10 (penalty 200) → 500
    expect(settlement.P1).toEqual({
      shortage: 10,
      purchaseCost: 300,
      penaltyCost: 200,
      yearCost: 500,
    })
  })
})

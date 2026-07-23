import { describe, expect, it } from 'vitest'
import { settleYear } from '../settlement'

const rates = { regulatorPrice: 10, sellPrice: 10, penaltyRate: 20 }

describe('settleYear (cost ledger)', () => {
  it('charges only the purchase cost when fully covered', () => {
    const { settlement } = settleYear(
      { P1: 100, P2: 200 },
      { P1: 120, P2: 200 }, // held ≥ realized → no shortage
      { P1: 40, P2: 0 }, // P1 bought 40 credits
      { P1: 0, P2: 0 }, // nothing sold
      rates,
    )
    expect(settlement.P1).toEqual({
      shortage: 0,
      purchaseCost: 400, // 40 × 10
      sellIncome: 0,
      penaltyCost: 0,
      yearCost: 400,
    })
    expect(settlement.P2.yearCost).toBe(0)
  })

  it('charges the penalty rate for uncovered shortage', () => {
    const { settlement } = settleYear({ P1: 100 }, { P1: 60 }, { P1: 0 }, { P1: 0 }, rates)
    // shortage 40 → penalty 40 × 20 = 800
    expect(settlement.P1).toEqual({
      shortage: 40,
      purchaseCost: 0,
      sellIncome: 0,
      penaltyCost: 800,
      yearCost: 800,
    })
  })

  it('credits sell income and can produce a negative (profit) year cost', () => {
    // Clean company: free 100, realized 60, sold 40 surplus at 10 → held 60, no shortage
    const { settlement } = settleYear({ P1: 60 }, { P1: 60 }, { P1: 0 }, { P1: 40 }, rates)
    expect(settlement.P1).toEqual({
      shortage: 0,
      purchaseCost: 0,
      sellIncome: 400,
      penaltyCost: 0,
      yearCost: -400,
    })
  })

  it('nets purchase, sell income and penalty into the year cost', () => {
    const { settlement } = settleYear({ P1: 100 }, { P1: 90 }, { P1: 30 }, { P1: 10 }, rates)
    // bought 30 (300) − sold 10 (100) + shortage 10 (200) = 400
    expect(settlement.P1.yearCost).toBe(400)
  })
})

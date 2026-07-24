import { describe, expect, it } from 'vitest'
import { settleYear } from '../settlement'

const rates = { regulatorPrice: 10, sellPrice: 10, penaltyRate: 20 }
const noAbate = { P1: 0, P2: 0 }

describe('settleYear (cost ledger)', () => {
  it('charges only the purchase cost when fully covered', () => {
    const { settlement } = settleYear(
      { P1: 100, P2: 200 },
      { P1: 120, P2: 200 }, // held ≥ realized → no shortage
      { P1: 40, P2: 0 }, // P1 bought 40 credits
      { P1: 0, P2: 0 }, // nothing sold
      noAbate,
      rates,
    )
    expect(settlement.P1).toEqual({
      shortage: 0,
      abatementCost: 0,
      purchaseCost: 400, // 40 × 10
      sellIncome: 0,
      penaltyCost: 0,
      yearCost: 400,
    })
    expect(settlement.P2.yearCost).toBe(0)
  })

  it('charges the penalty rate for uncovered shortage', () => {
    const { settlement } = settleYear({ P1: 100 }, { P1: 60 }, { P1: 0 }, { P1: 0 }, { P1: 0 }, rates)
    // shortage 40 → penalty 40 × 20 = 800
    expect(settlement.P1).toEqual({
      shortage: 40,
      abatementCost: 0,
      purchaseCost: 0,
      sellIncome: 0,
      penaltyCost: 800,
      yearCost: 800,
    })
  })

  it('credits sell income and can produce a negative (profit) year cost', () => {
    // Clean company: free 100, realized 60, sold 40 surplus at 10 → held 60, no shortage
    const { settlement } = settleYear({ P1: 60 }, { P1: 60 }, { P1: 0 }, { P1: 40 }, { P1: 0 }, rates)
    expect(settlement.P1).toEqual({
      shortage: 0,
      abatementCost: 0,
      purchaseCost: 0,
      sellIncome: 400,
      penaltyCost: 0,
      yearCost: -400,
    })
  })

  it('nets abatement, purchase, sell income and penalty into the year cost', () => {
    // abate 150, bought 30 (300) − sold 10 (100) + shortage 10 (200) = 550
    const { settlement } = settleYear(
      { P1: 100 },
      { P1: 90 },
      { P1: 30 },
      { P1: 10 },
      { P1: 150 },
      rates,
    )
    expect(settlement.P1.abatementCost).toBe(150)
    expect(settlement.P1.yearCost).toBe(550)
  })
})

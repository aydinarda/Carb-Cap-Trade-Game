import { describe, expect, it } from 'vitest'
import { settleYear } from '../settlement'

// purchaseCost and sellIncome are passed in as MONEY (the caller derives them from
// the auction clearing price and the market trade prices).
const rates = { penaltyRate: 20 }

describe('settleYear (cost ledger)', () => {
  it('charges only the purchase cost when fully covered', () => {
    const { settlement } = settleYear(
      { P1: 100, P2: 200 },
      { P1: 120, P2: 200 }, // held ≥ realized → no shortage
      { P1: 400, P2: 0 }, // P1 spent 400 acquiring credits
      { P1: 0, P2: 0 }, // no sell income
      { P1: 0, P2: 0 }, // no abatement
      rates,
    )
    expect(settlement.P1).toEqual({
      shortage: 0,
      abatementCost: 0,
      purchaseCost: 400,
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
    // Clean company: held 60, realized 60, earned 400 selling surplus → no shortage
    const { settlement } = settleYear({ P1: 60 }, { P1: 60 }, { P1: 0 }, { P1: 400 }, { P1: 0 }, rates)
    expect(settlement.P1).toEqual({
      shortage: 0,
      abatementCost: 0,
      purchaseCost: 0,
      sellIncome: 400,
      penaltyCost: 0,
      yearCost: -400,
    })
  })

  it('nets abatement, purchase cost, sell income and penalty into the year cost', () => {
    // abate 150 + spent 300 − earned 100 + shortage 10 (200) = 550
    const { settlement } = settleYear(
      { P1: 100 },
      { P1: 90 },
      { P1: 300 },
      { P1: 100 },
      { P1: 150 },
      rates,
    )
    expect(settlement.P1.abatementCost).toBe(150)
    expect(settlement.P1.yearCost).toBe(550)
  })
})

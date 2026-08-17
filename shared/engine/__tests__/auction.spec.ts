import { describe, expect, it } from 'vitest'
import { clearAuction } from '../auction'

describe('clearAuction (uniform-price, sealed-bid)', () => {
  it('fills highest bidders first; everyone pays the single clearing price', () => {
    // supply 100. Bids: A 60@15, B 60@10, C 60@5. Cumulative crosses 100 at B (price 10).
    const { clearingPrice, awarded } = clearAuction(
      { A: { qty: 60, price: 15 }, B: { qty: 60, price: 10 }, C: { qty: 60, price: 5 } },
      100,
    )
    expect(clearingPrice).toBe(10) // marginal (lowest accepted) bid
    expect(awarded.A).toBe(60) // above clearing → full
    expect(awarded.B).toBe(40) // marginal → remaining supply (100 − 60)
    expect(awarded.C).toBe(0) // below clearing → nothing
  })

  it('pro-rates bids tied at the marginal price', () => {
    // supply 100. A 40@20 (full), B 60@10 and C 60@10 share the remaining 60 pro-rata.
    const { clearingPrice, awarded } = clearAuction(
      { A: { qty: 40, price: 20 }, B: { qty: 60, price: 10 }, C: { qty: 60, price: 10 } },
      100,
    )
    expect(clearingPrice).toBe(10)
    expect(awarded.A).toBe(40)
    expect(awarded.B).toBe(30) // 60 × (60/120)
    expect(awarded.C).toBe(30)
  })

  it('with excess supply everyone wins fully; price is the lowest bid', () => {
    const { clearingPrice, awarded } = clearAuction(
      { A: { qty: 30, price: 12 }, B: { qty: 20, price: 6 } },
      100,
    )
    expect(clearingPrice).toBe(6)
    expect(awarded).toEqual({ A: 30, B: 20 })
  })

  it('fills the marginal bidder exactly when cumulative demand equals supply', () => {
    // supply 100. A 60@15, B 40@10 → cumulative hits exactly 100 at B; C gets nothing.
    const { clearingPrice, awarded } = clearAuction(
      { A: { qty: 60, price: 15 }, B: { qty: 40, price: 10 }, C: { qty: 20, price: 5 } },
      100,
    )
    expect(clearingPrice).toBe(10)
    expect(awarded).toEqual({ A: 60, B: 40, C: 0 })
  })

  it('a single under-demanding bidder clears at its own (only) price', () => {
    const { clearingPrice, awarded } = clearAuction({ A: { qty: 30, price: 12 } }, 100)
    expect(clearingPrice).toBe(12)
    expect(awarded).toEqual({ A: 30 })
  })

  it('ignores zero/empty bids and handles no supply', () => {
    expect(clearAuction({ A: { qty: 0, price: 10 } }, 100).awarded.A).toBe(0)
    expect(clearAuction({ A: { qty: 50, price: 10 } }, 0)).toEqual({
      clearingPrice: 0,
      awarded: { A: 0 },
    })
  })
})

import { describe, expect, it } from 'vitest'
import { createRng } from '../rng'
import { clearAuction, type AuctionBid } from '../auction'

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

describe('clearAuction — sweeps (several steps per company)', () => {
  it('clears a one-step sweep exactly like the plain bid, on any book', () => {
    const rng = createRng(7)
    for (let trial = 0; trial < 300; trial++) {
      const plain: Record<string, AuctionBid> = {}
      const swept: Record<string, AuctionBid> = {}
      for (let i = 0; i < 1 + rng.int(0, 6); i++) {
        const bid = { qty: Math.round(rng.next() * 3000) / 10, price: Math.round(rng.next() * 500) / 10 }
        plain[`P${i}`] = bid
        swept[`P${i}`] = { ...bid, steps: [{ ...bid }] }
      }
      const supply = Math.round(rng.next() * 6000) / 10
      const reserve = rng.next() < 0.5 ? 0 : Math.round(rng.next() * 300) / 10
      expect(clearAuction(swept, supply, reserve)).toEqual(clearAuction(plain, supply, reserve))
    }
  })

  it('ranks each step on its own and pays every credit the one clearing price', () => {
    // supply 150. A sweeps 100@30 + 100@10, B bids 100@20. Ranked: A30, B20, A10 → the
    // cumulative crosses 150 at B's step, so the price is 20; A's 10-step wins nothing.
    const { clearingPrice, awarded } = clearAuction(
      { A: { qty: 200, price: 30, steps: [{ qty: 100, price: 30 }, { qty: 100, price: 10 }] }, B: { qty: 100, price: 20 } },
      150,
    )
    expect(clearingPrice).toBe(20)
    expect(awarded).toEqual({ A: 100, B: 50 })
  })

  it('shares the marginal price pro-rata between a sweep step and a plain bid', () => {
    // supply 150. A: 100@30 + 100@20, B: 100@20. Above 20: A's 100. At 20: 200 asked for
    // the 50 left → a quarter each: A 100 + 25, B 25.
    const { clearingPrice, awarded } = clearAuction(
      { A: { qty: 200, price: 30, steps: [{ qty: 100, price: 30 }, { qty: 100, price: 20 }] }, B: { qty: 100, price: 20 } },
      150,
    )
    expect(clearingPrice).toBe(20)
    expect(awarded).toEqual({ A: 125, B: 25 })
  })

  it('fills every step when undersubscribed, at the lowest step price (or the reserve)', () => {
    const book = { A: { qty: 60, price: 30, steps: [{ qty: 40, price: 30 }, { qty: 20, price: 12 }] }, B: { qty: 10, price: 18 } }
    expect(clearAuction(book, 500)).toEqual({ clearingPrice: 12, awarded: { A: 60, B: 10 } })
    // A step under the reserve wins nothing, exactly as a plain bid there would.
    expect(clearAuction(book, 500, 15)).toEqual({ clearingPrice: 18, awarded: { A: 40, B: 10 } })
  })
})

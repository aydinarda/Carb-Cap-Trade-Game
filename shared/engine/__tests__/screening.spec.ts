import { describe, expect, it } from 'vitest'
import { DEFAULT_GAME_CONFIG } from '../../config'
import { screenRound, type ScreeningCompany } from '../screening'
import type { Trade } from '../../types'

const T = DEFAULT_GAME_CONFIG.screening
const company = (id: string, over: Partial<ScreeningCompany> = {}): ScreeningCompany => ({
  id, exempt: false, planned: 100, freeAllocation: 0, carriedIn: 0, auctionAward: 0, ...over,
})
const trade = (sellerId: string, buyerId: string, qty: number, price: number): Trade =>
  ({ id: `${sellerId}-${buyerId}-${qty}`, buyerId, sellerId, qty, price, seq: 1 }) as unknown as Trade

describe('screenRound (market-cornering screening)', () => {
  const round = (companies: ScreeningCompany[], trades: Trade[]) =>
    screenRound({ companies, pool: 1000, auctionPrice: 25, previousClose: 30, trades }, T)

  it('flags a company that took far more than it needs and resold it dear, with its reasons', () => {
    const flags = round([company('A', { auctionAward: 300 }), company('B')], [trade('A', 'B', 200, 55)])
    expect(Object.keys(flags)).toEqual(['A'])
    expect(flags.A.join(' | ')).toMatch(/won 300 t at the auction, 3× its need/)
    expect(flags.A.join(' | ')).toMatch(/took 30% of the auction supply/)
    expect(flags.A.join(' | ')).toMatch(/resold 200 t .* at 55, 2\.2× the auction price/)
  })

  it('does not flag either signal alone', () => {
    // Over-bought but kept it: concentration only.
    expect(round([company('A', { auctionAward: 300 }), company('B')], [])).toEqual({})
    // Sold dear but never took more than it needs: exploitation only.
    expect(round([company('A', { auctionAward: 100 }), company('B')], [trade('A', 'B', 60, 55)])).toEqual({})
  })

  it('never flags a market maker', () => {
    expect(round([company('M', { exempt: true, auctionAward: 300 }), company('B')], [trade('M', 'B', 200, 55)])).toEqual({})
  })

  it("does not count a big emitter's share of circulation as concentration when it holds what it needs", () => {
    // No auction: a company holding 80% of the credits — but only its own emission's worth.
    const flags = screenRound(
      { companies: [company('Big', { planned: 800, freeAllocation: 800 }), company('S', { planned: 200, freeAllocation: 200 })], pool: 0, auctionPrice: null, previousClose: 30, trades: [trade('Big', 'S', 500, 60)] },
      T,
    )
    expect(flags).toEqual({})
  })
})

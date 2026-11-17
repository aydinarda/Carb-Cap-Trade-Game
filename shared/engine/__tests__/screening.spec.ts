import { describe, expect, it } from 'vitest'
import { DEFAULT_GAME_CONFIG } from '../../config'
import { replayStockYear, screenRound, stockSignals, type ScreeningCompany, type StockCompany } from '../screening'
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

describe('replayStockYear (the active screening stock ledger)', () => {
  const co = (id: string, over: Partial<StockCompany> = {}): StockCompany => ({
    id, exempt: false, keep: 130, startHeld: 0, award: 0, awardPrice: 0, ...over,
  })

  it('counts only tonnes bought above the keep line, at what they cost', () => {
    // Free 100, buys 50 at 20: holds 150 against a line of 130, so 20 t of stock at 20.
    const b = replayStockYear({}, [co('A', { startHeld: 100 })], [trade('X', 'A', 50, 20)])
    expect(b.A.excess).toBeCloseTo(20)
    expect(b.A.cost).toBeCloseTo(400)
    // An auction award counts the same way, at the clearing price.
    const a = replayStockYear({}, [co('A', { startHeld: 100, award: 80, awardPrice: 30 })], [])
    expect(a.A).toMatchObject({ excess: 50, cost: 1500 })
  })

  it('a sale out of the stock realises the profit above its average cost; below cost counts 0', () => {
    const b = replayStockYear({}, [co('A', { startHeld: 130 })], [
      trade('X', 'A', 100, 20), // all 100 t above the line, at 20
      trade('A', 'Y', 60, 50), // +30 a tonne on 60 t
      trade('A', 'Z', 40, 10), // a loss: no credit
    ])
    expect(b.A.realized).toBeCloseTo(1800)
    expect(b.A).toMatchObject({ excess: 0, soldTonnes: 100 })
  })

  it('never touches free allocation or surplus banked from abatement', () => {
    // Holds 300 free against a line of 130 and sells 150 dear: it bought nothing, so no extra profit.
    const b = replayStockYear({}, [co('A', { startHeld: 300 })], [trade('A', 'Y', 150, 80)])
    expect(b.A).toMatchObject({ excess: 0, realized: 0 })
  })

  it('stock the company needs after all leaves at cost: the next year starts trimmed to its line', () => {
    const y1 = replayStockYear({}, [co('A', { startHeld: 130, award: 70, awardPrice: 30 })], [])
    expect(y1.A).toMatchObject({ excess: 70, cost: 2100 })
    // It surrendered most of it: it opens next year with 160 against the same line, so 30 t remain.
    const y2 = replayStockYear(y1, [co('A', { startHeld: 160 })], [])
    expect(y2.A.excess).toBeCloseTo(30)
    expect(y2.A.cost).toBeCloseTo(900)
    expect(y2.A.realized).toBe(0)
  })

  it('a confiscation takes tonnes out of the stock first, at cost, in its place among the trades', () => {
    const b = replayStockYear(
      {},
      [co('A', { startHeld: 130 })],
      [trade('X', 'A', 100, 20), trade('A', 'Y', 10, 50)],
      [{ playerId: 'A', qty: 100, atTrade: 1 }], // taken back before the sale
    )
    expect(b.A).toMatchObject({ excess: 0, realized: 0 })
  })

  it('keeps its memory across years: stock bought cheap in one year and sold dear in a later one', () => {
    const y1 = replayStockYear({}, [co('A', { startHeld: 130 })], [trade('X', 'A', 500, 25)])
    const y2 = replayStockYear(y1, [co('A', { startHeld: 630 })], [trade('A', 'Y', 500, 150)])
    expect(y2.A.realized).toBeCloseTo(500 * 125)
  })

  it('does not track pure traders', () => {
    expect(replayStockYear({}, [co('M', { exempt: true })], [trade('X', 'M', 100, 20)])).toEqual({})
  })
})

describe('stockSignals (the host list colours)', () => {
  const t = { yellowExcess: 0.2, redExcess: 1.7, yellowProfit: 15, redProfit: 150 }
  const book = (excess: number, cost = 0) => ({ excess, cost, realized: 0, soldTonnes: 0, soldValue: 0, soldCost: 0 })

  it('colours by the worse of stock and profit, each scaled to the company', () => {
    expect(stockSignals(book(0), 100, 100, 0, t).color).toBe('none')
    expect(stockSignals(book(10), 100, 100, 0, t).color).toBe('none') // 0.1× its need
    expect(stockSignals(book(30, 600), 100, 100, 0, t)).toMatchObject({ color: 'yellow', excessRatio: 0.3 })
    expect(stockSignals(book(200), 100, 100, 0, t).color).toBe('red')
    expect(stockSignals(book(0), 100, 100, 2_000, t)).toMatchObject({ color: 'yellow', profitPerTonne: 20 })
    expect(stockSignals(book(0), 100, 100, 20_000, t).color).toBe('red')
    // The same euros are minor for a big emitter.
    expect(stockSignals(book(0), 10_000, 10_000, 20_000, t).color).toBe('none')
    // Reasons say why.
    expect(stockSignals(book(200, 4000), 100, 100, 20_000, t).reasons.join(' | ')).toMatch(/holds 200 t it bought above its need, 2× .* \| made €20,000 of extra profit/)
  })
})

import { describe, expect, it } from 'vitest'
import type { Trade } from '@shared/types'
import { newFills } from '../fills'

const YOU = 'P1'
let seq = 0
const buy = (id: string, qty: number, price: number): Trade => ({ id, buyerId: YOU, sellerId: 'P9', qty, price, seq: ++seq })
const sell = (id: string, qty: number, price: number): Trade => ({ id, buyerId: 'P9', sellerId: YOU, qty, price, seq: ++seq })
/** As the snapshot sends `myTrades`: newest first. */
const snapshot = (...oldestFirst: Trade[]) => [...oldestFirst].reverse()

describe('newFills: notifications for your own fills', () => {
  it('says nothing about fills it has already seen', () => {
    const trades = snapshot(buy('a', 5, 40), sell('b', 3, 45))
    const seen = new Set(trades.map((t) => t.id))
    expect(newFills(trades, seen, YOU)).toEqual([])
  })

  it('one new buy: its quantity, price and total', () => {
    const seen = new Set<string>()
    expect(newFills(snapshot(buy('a', 5, 45)), seen, YOU)).toEqual([
      { key: 'a', side: 'buy', qty: 5, total: 225, avgPrice: 45, trades: 1 },
    ])
    expect(seen.has('a')).toBe(true)
  })

  it('an order that sweeps three levels in one snapshot is one notification with the totals', () => {
    const fills = newFills(snapshot(buy('a', 4, 44), buy('b', 5, 45), buy('c', 3, 47)), new Set(), YOU)
    expect(fills).toEqual([{ key: 'a', side: 'buy', qty: 12, total: 542, avgPrice: 45.2, trades: 3 }])
  })

  it('a buy and a sell in the same snapshot are two notifications', () => {
    const fills = newFills(snapshot(sell('a', 2, 50), buy('b', 6, 48)), new Set(), YOU)
    expect(fills.map((f) => [f.side, f.qty])).toEqual([
      ['sell', 2],
      ['buy', 6],
    ])
  })

  it('a fill in a later snapshot is a notification of its own', () => {
    const seen = new Set<string>()
    const first = snapshot(buy('a', 5, 45))
    expect(newFills(first, seen, YOU)).toHaveLength(1)
    const later = snapshot(buy('a', 5, 45), sell('b', 4, 52))
    expect(newFills(later, seen, YOU)).toEqual([
      { key: 'b', side: 'sell', qty: 4, total: 208, avgPrice: 52, trades: 1 },
    ])
  })

  it('rounds to one decimal', () => {
    const fills = newFills(snapshot(buy('a', 0.3, 33.3), buy('b', 0.4, 41.1)), new Set(), YOU)
    expect(fills).toEqual([{ key: 'a', side: 'buy', qty: 0.7, total: 26.4, avgPrice: 37.8, trades: 2 }])
  })
})

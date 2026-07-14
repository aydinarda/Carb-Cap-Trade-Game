import { describe, expect, it } from 'vitest'
import type { Order } from '../../types'
import {
  buildMarketView,
  cancelOrder,
  matchOrder,
  openSellRemaining,
  tradedNet,
} from '../orderBook'

let seq = 0
let tradeId = 0
const makeTradeId = () => `T${++tradeId}`

function order(playerId: string, side: Order['side'], qty: number, price: number): Order {
  seq += 1
  return { id: `O${seq}`, playerId, side, qty, remaining: qty, price, status: 'open', seq }
}

describe('matchOrder', () => {
  it('matches an incoming buy against the cheapest crossing ask at the resting price', () => {
    const orders: Order[] = []
    matchOrder(orders, order('P1', 'sell', 30, 12), makeTradeId)
    matchOrder(orders, order('P2', 'sell', 30, 11), makeTradeId)
    const { trades } = matchOrder(orders, order('P3', 'buy', 20, 12.5), makeTradeId)

    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ buyerId: 'P3', sellerId: 'P2', qty: 20, price: 11 })
    expect(orders.find((o) => o.playerId === 'P2')!.remaining).toBe(10)
  })

  it('fills across multiple price levels with partial fills and leaves the rest resting', () => {
    const orders: Order[] = []
    matchOrder(orders, order('P1', 'sell', 10, 10), makeTradeId)
    matchOrder(orders, order('P2', 'sell', 15, 11), makeTradeId)
    const { trades } = matchOrder(orders, order('P3', 'buy', 40, 11), makeTradeId)

    expect(trades.map((t) => [t.sellerId, t.qty, t.price])).toEqual([
      ['P1', 10, 10],
      ['P2', 15, 11],
    ])
    const rest = orders.find((o) => o.playerId === 'P3')!
    expect(rest.status).toBe('open')
    expect(rest.remaining).toBe(15) // 40 − 25 rests as a bid at 11
  })

  it('does not cross when prices do not overlap', () => {
    const orders: Order[] = []
    matchOrder(orders, order('P1', 'sell', 10, 15), makeTradeId)
    const { trades } = matchOrder(orders, order('P2', 'buy', 10, 14), makeTradeId)
    expect(trades).toHaveLength(0)
    expect(orders.filter((o) => o.status === 'open')).toHaveLength(2)
  })

  it('uses time priority at equal prices', () => {
    const orders: Order[] = []
    matchOrder(orders, order('P1', 'sell', 10, 12), makeTradeId)
    matchOrder(orders, order('P2', 'sell', 10, 12), makeTradeId)
    const { trades } = matchOrder(orders, order('P3', 'buy', 10, 12), makeTradeId)
    expect(trades[0].sellerId).toBe('P1')
  })

  it('never matches a player against their own resting order', () => {
    const orders: Order[] = []
    matchOrder(orders, order('P1', 'sell', 10, 12), makeTradeId)
    const { trades } = matchOrder(orders, order('P1', 'buy', 10, 13), makeTradeId)
    expect(trades).toHaveLength(0)
    // both of P1's orders rest in the book
    expect(orders.filter((o) => o.playerId === 'P1' && o.status === 'open')).toHaveLength(2)
  })
})

describe('cancelOrder', () => {
  it('cancels only your own open order', () => {
    const orders: Order[] = []
    matchOrder(orders, order('P1', 'sell', 10, 12), makeTradeId)
    const target = orders[0]
    expect(cancelOrder(orders, 'P2', target.id)).toBe(false)
    expect(cancelOrder(orders, 'P1', target.id)).toBe(true)
    expect(target.status).toBe('cancelled')
    expect(cancelOrder(orders, 'P1', target.id)).toBe(false)
  })
})

describe('helpers', () => {
  it('tradedNet and openSellRemaining track positions', () => {
    const orders: Order[] = []
    matchOrder(orders, order('P1', 'sell', 30, 12), makeTradeId)
    const { trades } = matchOrder(orders, order('P2', 'buy', 20, 12), makeTradeId)

    expect(tradedNet(trades, 'P1')).toBe(-20)
    expect(tradedNet(trades, 'P2')).toBe(20)
    expect(openSellRemaining(orders, 'P1')).toBe(10)

    const view = buildMarketView(orders, trades)
    expect(view.lastPrice).toBe(12)
    expect(view.bestAsk).toBe(12)
    expect(view.volume).toBe(20)
    expect(view.vwap).toBe(12)
  })
})

import type { MarketView, Order, OrderSide, Trade } from '../types'
import { round1 } from './rng'

/**
 * Student-driven continuous double auction. Prices come entirely from the
 * players' limit orders — there is no external price feed.
 *
 * Matching rules:
 *  - an incoming buy fills against open asks with price ≤ its limit, cheapest first
 *  - an incoming sell fills against open bids with price ≥ its limit, highest first
 *  - ties break by time priority (lower seq first)
 *  - the trade executes at the RESTING order's price
 *  - partial fills leave the remainder resting in the book
 *  - a player's order never matches their own resting orders (skipped, left intact)
 *  - `blocked` can veto a pair beyond that — see the market-maker rule below
 */
export function matchOrder(
  orders: Order[],
  incoming: Order,
  makeTradeId: () => string,
  /**
   * Optional veto on a counterparty pair, applied on top of self-match prevention.
   *
   * Used to stop market makers trading with each other. Several makers quoting a band
   * around the same reference price inevitably cross, and those fills are not liquidity —
   * they are inventory moving between market makers, at prices that then feed back into the
   * reference every maker quotes from. Left alone it is a closed loop that generates volume
   * and moves the price without any emitter ever being served.
   */
  blocked?: (a: string, b: string) => boolean,
): { trades: Trade[] } {
  const trades: Trade[] = []
  const oppositeSide: OrderSide = incoming.side === 'buy' ? 'sell' : 'buy'

  const crosses = (resting: Order) =>
    incoming.side === 'buy' ? resting.price <= incoming.price : resting.price >= incoming.price

  while (incoming.remaining > 0) {
    const candidates = orders
      .filter(
        (o) =>
          o.status === 'open' &&
          o.side === oppositeSide &&
          o.playerId !== incoming.playerId &&
          o.remaining > 0 &&
          crosses(o) &&
          !blocked?.(incoming.playerId, o.playerId),
      )
      .sort((a, b) =>
        incoming.side === 'buy'
          ? a.price - b.price || a.seq - b.seq
          : b.price - a.price || a.seq - b.seq,
      )
    const best = candidates[0]
    if (!best) break

    const qty = round1(Math.min(incoming.remaining, best.remaining))
    best.remaining = round1(best.remaining - qty)
    incoming.remaining = round1(incoming.remaining - qty)
    if (best.remaining === 0) best.status = 'filled'
    if (incoming.remaining === 0) incoming.status = 'filled'

    trades.push({
      id: makeTradeId(),
      buyerId: incoming.side === 'buy' ? incoming.playerId : best.playerId,
      sellerId: incoming.side === 'sell' ? incoming.playerId : best.playerId,
      qty,
      price: best.price,
      seq: incoming.seq,
    })
  }

  orders.push(incoming)
  return { trades }
}

export function cancelOrder(orders: Order[], playerId: string, orderId: string): boolean {
  const order = orders.find((o) => o.id === orderId && o.playerId === playerId)
  if (!order || order.status !== 'open') return false
  order.status = 'cancelled'
  return true
}

/** Net credits bought minus sold via executed trades, per player. */
export function tradedNet(trades: Trade[], playerId: string): number {
  let net = 0
  for (const t of trades) {
    if (t.buyerId === playerId) net += t.qty
    if (t.sellerId === playerId) net -= t.qty
  }
  return round1(net)
}

/**
 * Net traded position for *every* player, in one pass over the tape.
 *
 * The per-player `tradedNet` above is right when you want one player, but calling it inside
 * a players×years loop rescans the whole year's trades once per player — which is what made
 * building the host's year-by-year history quadratic in class size.
 */
export function tradedNetAll(trades: Trade[]): Record<string, number> {
  const net: Record<string, number> = {}
  for (const t of trades) {
    net[t.buyerId] = (net[t.buyerId] ?? 0) + t.qty
    net[t.sellerId] = (net[t.sellerId] ?? 0) - t.qty
  }
  for (const id of Object.keys(net)) net[id] = round1(net[id])
  return net
}

/** Mean price of the last `n` prints. Returns null when nothing has traded. */
export function meanOfLast(trades: Trade[], n: number): number | null {
  if (trades.length === 0) return null
  const tail = trades.slice(-Math.max(1, n))
  return round1(tail.reduce((sum, t) => sum + t.price, 0) / tail.length)
}

/**
 * Volume-weighted average of the LAST `n` prints — where the market ended, not where it
 * averaged.
 *
 * The whole-year VWAP was the wrong anchor for the next year: a year that opened at 40,
 * spiked to 190 and settled back to 90 hands the next year an average that matches none of
 * those, and in a volatile year it is dominated by whichever phase happened to carry the
 * volume. The tail is what the class actually last agreed a tonne was worth.
 *
 * Volume-weighted rather than a plain mean (`meanOfLast`) because one 200-tonne block and
 * one 2-tonne odd lot are not equal evidence about the price.
 */
export function vwapOfLast(trades: Trade[], n: number): number | null {
  if (trades.length === 0) return null
  const tail = trades.slice(-Math.max(1, n))
  const volume = tail.reduce((s, t) => s + t.qty, 0)
  if (volume <= 0) return null
  return Math.round((tail.reduce((s, t) => s + t.qty * t.price, 0) / volume) * 100) / 100
}

/** Cash a player spent buying and earned selling via executed trades. */
export function tradedCash(trades: Trade[], playerId: string): { buyCash: number; sellCash: number } {
  let buyCash = 0
  let sellCash = 0
  for (const t of trades) {
    if (t.buyerId === playerId) buyCash += t.qty * t.price
    if (t.sellerId === playerId) sellCash += t.qty * t.price
  }
  return { buyCash: round1(buyCash), sellCash: round1(sellCash) }
}

/** Total quantity a player still has resting in open sell orders. */
export function openSellRemaining(orders: Order[], playerId: string): number {
  return round1(
    orders
      .filter((o) => o.playerId === playerId && o.side === 'sell' && o.status === 'open')
      .reduce((s, o) => s + o.remaining, 0),
  )
}

/** How much of the book/tape to put on the wire. Aggregates below use the FULL data;
 * only the returned arrays are truncated, keeping snapshots small at classroom scale
 * (many bots can pile up thousands of orders/trades within a year). */
const MAX_DEPTH_LEVELS = 25
const MAX_TAPE = 60

export function buildMarketView(orders: Order[], trades: Trade[]): MarketView {
  const open = orders.filter((o) => o.status === 'open' && o.remaining > 0)
  const bids = open.filter((o) => o.side === 'buy').sort((a, b) => b.price - a.price || a.seq - b.seq)
  const asks = open.filter((o) => o.side === 'sell').sort((a, b) => a.price - b.price || a.seq - b.seq)
  const volume = round1(trades.reduce((s, t) => s + t.qty, 0))
  const notional = trades.reduce((s, t) => s + t.qty * t.price, 0)
  return {
    // Best levels / most recent tape only; the aggregates below still reflect all data.
    bids: bids.slice(0, MAX_DEPTH_LEVELS),
    asks: asks.slice(0, MAX_DEPTH_LEVELS),
    trades: trades.slice(-MAX_TAPE).reverse(),
    lastPrice: trades.length > 0 ? trades[trades.length - 1].price : null,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    vwap: volume > 0 ? Math.round((notional / volume) * 100) / 100 : null,
    volume,
  }
}

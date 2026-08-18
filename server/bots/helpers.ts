import { openSellRemaining, round1, tradedCash } from '../../shared/engine'
import type { MarketView, OrderSide, YearRecord } from '../../shared/types'
import { GameError, type Session } from '../session'

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * The reference price the bots anchor to this year — the price signal. Once the
 * auction has cleared, THIS year's clearing price is the freshest signal (everyone
 * just paid it for their allowances), so the secondary market anchors there. Before
 * that (cap stage, or the free-allocation modes with no auction) it falls back to the
 * session's opening reference: the previous settled year's discovered price, then to
 * half the penalty as a neutral first-year default.
 */
export function referencePrice(session: Session): number {
  const auctionPrice = session.currentYearRecord()?.auctionPrice
  if (auctionPrice && auctionPrice > 0) return auctionPrice
  return session.openingReference()
}

/** Apply a bot's personality bias to a price and clamp it into (0.1, penaltyRate]. */
export function disperse(price: number, bias: number, penaltyRate: number, minPrice = 0.1): number {
  return round1(clamp(price * (1 + bias), minPrice, penaltyRate))
}

/**
 * Perceived value / mid the bots price around. Falls back to `ref` (the previous
 * round's discovered price) when the book is still empty, so a fresh year's quotes
 * start near last year's price instead of collapsing to P/2.
 */
export function marketMid(mv: MarketView, ref: number): number {
  return mv.lastPrice ?? mv.vwap ?? ref
}

/** Perceived fair value for a market view (VWAP-anchored), falling back to `ref`. */
export function anchorValue(mv: MarketView, ref: number): number {
  return mv.vwap ?? mv.lastPrice ?? ref
}

/** Credits a bot can still offer without shorting (held minus its open asks). */
export function sellCapacity(session: Session, record: YearRecord, botId: string): number {
  return round1(session.creditsHeld(botId) - openSellRemaining(record.orders, botId))
}

export function ownOpenOrders(record: YearRecord, botId: string) {
  return record.orders.filter((o) => o.playerId === botId && o.status === 'open')
}

/** Cancel all of a bot's resting orders (for requoting). Returns whether any were cancelled. */
export function cancelAllOrders(session: Session, record: YearRecord, botId: string): boolean {
  let did = false
  for (const o of ownOpenOrders(record, botId)) {
    try {
      session.cancelOrder(botId, o.id)
      did = true
    } catch (e) {
      if (!(e instanceof GameError)) throw e
    }
  }
  return did
}

/**
 * Realized average acquisition cost of a bot's current inventory: auction spend +
 * market buys over gross bought quantity. Null if it has acquired nothing.
 */
export function botAvgCost(record: YearRecord, botId: string): number | null {
  const { buyCash } = tradedCash(record.trades, botId)
  const grossBought = record.trades
    .filter((t) => t.buyerId === botId)
    .reduce((s, t) => s + t.qty, 0)
  const auctionQty = record.regulatorGranted[botId] ?? 0
  const auctionCost = auctionQty * (record.auctionPrice ?? 0)
  const totQty = auctionQty + grossBought
  if (totQty <= 0) return null
  return (auctionCost + buyCash) / totQty
}

/** Place a limit order, clamping qty to a step and swallowing GameError (skips the tick). */
export function tryPlace(
  session: Session,
  botId: string,
  side: OrderSide,
  qty: number,
  price: number,
): boolean {
  const q = round1(Math.min(qty, session.state.config.bots.maxStep))
  const p = round1(price)
  if (!(q > 0) || !(p > 0)) return false
  try {
    session.placeOrder(botId, side, q, p)
    return true
  } catch (e) {
    if (!(e instanceof GameError)) throw e
    return false
  }
}

/** Sell wrapper that clamps to the no-shorting capacity first. */
export function trySell(
  session: Session,
  record: YearRecord,
  botId: string,
  qty: number,
  price: number,
): boolean {
  const cap = sellCapacity(session, record, botId)
  return tryPlace(session, botId, 'sell', Math.min(qty, cap), price)
}

/** Submit/overwrite an auction bid, swallowing GameError. */
export function trySubmitBid(session: Session, botId: string, qty: number, price: number): boolean {
  if (!(round1(qty) > 0) || !(round1(price) > 0)) return false
  try {
    session.submitBid(botId, round1(qty), round1(price))
    return true
  } catch (e) {
    if (!(e instanceof GameError)) throw e
    return false
  }
}

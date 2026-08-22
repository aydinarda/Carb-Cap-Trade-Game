import { openSellRemaining, round1, tradedCash } from '../../shared/engine'
import type { MarketView, Order, OrderSide, YearRecord } from '../../shared/types'
import type { BotRuntime } from './types'
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

/**
 * The highest price an agent is willing to quote.
 *
 * Shipped behaviour is `penaltyRate` — the "never pay more than the fine" rule every
 * archetype has always followed. That rule does not actually hold in this game: paying the
 * fine does NOT discharge the obligation (see `settleYear`), the uncovered tonne is carried
 * forward as make-good debt and settled later, so defaulting costs the fine PLUS that later
 * settlement. The engine imposes no cap precisely because of this; the cap lives only in
 * agent code, which is why a genuinely uncoverable shortage pins just under the fine instead
 * of pricing through it.
 *
 * `bots.fixes.ceilingIncludesCarry` prices the carry: `penaltyRate + referencePrice`, a
 * one-period approximation of what settling the same tonne later costs.
 */
export function priceCeiling(session: Session): number {
  const P = session.state.config.market.penaltyRate
  if (!session.state.config.bots.fixes.ceilingIncludesCarry) return P
  return round1(P + referencePrice(session))
}

/** Apply a bot's personality bias to a price and clamp it into (0.1, ceiling]. */
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

/**
 * The price the market maker quotes around: the mean of the last `n` executed trades.
 *
 * A short moving average of actual prints, not `vwap` (which weights the whole year) and not
 * `lastPrice` (which is one possibly-outlier trade). Before anything has traded this year it
 * falls back to the previous year's discovered price, so the first tick of a trade window
 * still has a sensible centre.
 */
export function recentPrice(session: Session, record: YearRecord, n: number): number {
  const { trades } = record
  if (trades.length === 0) return referencePrice(session)
  const tail = trades.slice(-Math.max(1, n))
  return round1(tail.reduce((sum, t) => sum + t.price, 0) / tail.length)
}

/** Credits a bot can still offer without shorting (held minus its open asks). */
export function sellCapacity(session: Session, record: YearRecord, botId: string): number {
  return round1(session.creditsHeld(botId) - openSellRemaining(record.orders, botId))
}

export function ownOpenOrders(record: YearRecord, botId: string) {
  return record.orders.filter((o) => o.playerId === botId && o.status === 'open')
}

/** A bot's open orders on one side of the book. */
export function ownOpenOrdersOn(record: YearRecord, botId: string, side: OrderSide) {
  return record.orders.filter(
    (o) => o.playerId === botId && o.side === side && o.status === 'open',
  )
}

/**
 * Bring the bot's own resting quote on one side in line with what it now wants.
 *
 * Returns false — and leaves the book completely untouched — when that quote is already
 * resting at the right price with enough size, which is the common case in a quiet market.
 * Bots used to cancel and re-place their whole stack every tick, so `acted` was permanently
 * true (a full broadcast to every socket, 24×/min) and `record.orders` grew without bound
 * even when the book had not changed at all.
 *
 * It tracks the quote by ID rather than by price, so it never disturbs the bot's OTHER
 * resting orders — notably the unfilled remainder of a marketable order, which is real
 * depth the maker is providing.
 */
export function syncQuote(
  session: Session,
  record: YearRecord,
  botId: string,
  rt: BotRuntime,
  side: OrderSide,
  qty: number,
  price: number,
): boolean {
  const q = round1(Math.min(qty, session.state.config.bots.maxStep))
  const p = round1(price)
  if (!(q > 0) || !(p > 0)) return false

  const prevId = rt.quoteId?.[side]
  const prev = prevId
    ? record.orders.find((o) => o.id === prevId && o.status === 'open')
    : undefined

  // Same price, enough size still resting — leave it exactly where it is.
  if (prev && prev.price === p && prev.remaining >= q) return false

  let changed = false
  if (prev) {
    try {
      session.cancelOrder(botId, prev.id)
      changed = true
    } catch (e) {
      if (!(e instanceof GameError)) throw e
    }
  }
  if (!tryPlace(session, botId, side, q, p)) {
    if (changed) rt.quoteId = { ...rt.quoteId, [side]: undefined }
    // A cancel with no replacement still changed the book.
    return changed
  }
  // Remember what we just placed. A marketable quote can fill outright, in which case
  // nothing is left resting and the next tick simply places a fresh one.
  let newest: Order | undefined
  for (const o of record.orders) {
    if (o.playerId !== botId || o.side !== side || o.status !== 'open') continue
    if (!newest || o.seq > newest.seq) newest = o
  }
  rt.quoteId = { ...rt.quoteId, [side]: newest?.id }
  return true
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

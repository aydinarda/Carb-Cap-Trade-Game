import { buildMarketView } from '../../shared/engine'
import {
  anchorValue,
  botAvgCost,
  cancelAllOrders,
  clamp,
  disperse,
  referencePrice,
  sellCapacity,
  tryPlace,
  trySell,
  trySubmitBid,
} from './helpers'
import type { BotCtx } from './types'

/**
 * Market maker (financial player, ~0 emissions). No fixed price: it shifts its
 * reservation centre with its inventory (long → quote down to offload, short →
 * quote up to acquire) and keeps a margin. It never sells below its realized
 * average cost + margin (profit guarantee) and opportunistically buys asks below
 * centre / sells to bids above centre — capturing value from both sides.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.market.penaltyRate
  const cfg = session.state.config.bots.marketMaker
  const minPrice = session.state.config.bots.minPrice

  // Clear stale quotes first so the book's best reflects real (non-self) liquidity.
  cancelAllOrders(session, record, bot.id)
  const mv = buildMarketView(record.orders, record.trades)

  const anchor = anchorValue(mv, referencePrice(session)) * (1 + (ctx.rt.bias ?? 0)) // personality-shifted value
  const margin = Math.max(cfg.minMargin, cfg.spreadFrac * anchor)
  // Target inventory is a slice of everything in circulation — the auction pool under
  // auctioning (where free allocation is 0), the class's free allocation otherwise.
  const target = cfg.invFrac * session.circulatingCap()
  const held = session.creditsHeld(bot.id)
  const skewCap = cfg.skewCapFrac * P
  const skew = clamp(cfg.skew * (held - target), -skewCap, skewCap)
  // An allowance is never worth more than the penalty — paying it is exactly the
  // alternative to holding one — so the perceived value is capped there, and with it
  // every quote derived from it. This binds under a tight benchmark, where the price
  // rides at the ceiling instead of sitting comfortably below it.
  const center = Math.min(anchor - skew, P)
  const avg = botAvgCost(record, bot.id)
  const askFloor = avg !== null ? avg + cfg.minMargin : center + margin

  let acted = false

  // Opportunistic: lift an ask cheaper than centre (buy cheap)…
  if (mv.bestAsk !== null && mv.bestAsk < center) {
    acted = tryPlace(session, bot.id, 'buy', cfg.quoteSize, mv.bestAsk) || acted
  }
  // …and hit a bid richer than centre, but never below our profit floor (sell rich).
  if (mv.bestBid !== null && mv.bestBid > center && mv.bestBid >= askFloor) {
    acted = trySell(session, record, bot.id, cfg.quoteSize, mv.bestBid) || acted
  }

  // Rest fresh two-sided quotes around the inventory-shifted centre.
  const bid = clamp(center - margin, minPrice, P - minPrice)
  acted = tryPlace(session, bot.id, 'buy', cfg.quoteSize, bid) || acted
  // Capped at the penalty like the bid. If that still clears our profit floor we
  // quote; if it does not, we sit out rather than sell the book at a loss.
  const ask = clamp(Math.max(center + margin, askFloor), minPrice, P)
  if (ask >= askFloor && sellCapacity(session, record, bot.id) > 0) {
    acted = trySell(session, record, bot.id, cfg.quoteSize, ask) || acted
  }
  return acted
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.market.penaltyRate
  const cfg = session.state.config.bots.marketMaker
  const target = cfg.invFrac * session.circulatingCap() // deep inventory to two-side the market
  if (target <= 0) return false
  // Bid above the discovered reference (to win inventory), capped at P and dispersed.
  const price = disperse(Math.min(P, referencePrice(session) * cfg.auctionAggr), ctx.rt.bias ?? 0, P)
  return trySubmitBid(session, bot.id, target, price)
}

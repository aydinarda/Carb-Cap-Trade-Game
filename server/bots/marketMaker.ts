import { buildMarketView } from '../../shared/engine'
import {
  anchorValue,
  botAvgCost,
  clamp,
  disperse,
  referencePrice,
  sellCapacity,
  syncQuote,
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

  // The maker must price against OTHER people's liquidity, or its opportunistic legs would
  // chase its own resting quote. It used to get that by cancelling everything first, which
  // is what churned the book every tick; filtering is the same view without the churn. Only
  // one or two makers exist, so this stays O(orders), not O(bots × orders).
  const mv = buildMarketView(
    record.orders.filter((o) => o.playerId !== bot.id),
    record.trades,
  )

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

  // Rest two-sided quotes around the inventory-shifted centre. `syncQuote` leaves an
  // already-correct quote exactly where it is, so a quiet market costs nothing.
  const bid = clamp(center - margin, minPrice, P - minPrice)
  acted = syncQuote(session, record, bot.id, ctx.rt, 'buy', cfg.quoteSize, bid) || acted
  // Capped at the penalty like the bid. If that still clears our profit floor we
  // quote; if it does not, we sit out rather than sell the book at a loss.
  const ask = clamp(Math.max(center + margin, askFloor), minPrice, P)
  const room = sellCapacity(session, record, bot.id)
  if (ask >= askFloor && room > 0) {
    acted =
      syncQuote(session, record, bot.id, ctx.rt, 'sell', Math.min(cfg.quoteSize, room), ask) || acted
  }
  return acted
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.market.penaltyRate
  const cfg = session.state.config.bots.marketMaker
  const fixes = session.state.config.bots.fixes
  let target = cfg.invFrac * session.circulatingCap() // deep inventory to two-side the market
  // Every maker sizes its target off the WHOLE pool, so N makers chase N × invFrac of it —
  // four of them bid 72% of the cap. Gated: bots.fixes.marketMakerShareByCount.
  if (fixes.marketMakerShareByCount) {
    const makers = session.state.players.filter((p) => p.botType === 'marketMaker').length
    if (makers > 1) target /= makers
  }
  // The target is a LEVEL, but it was bid every year as an incremental purchase — nothing
  // subtracted what the maker already held, so its inventory compounded without bound and
  // it ended up sitting on credits nobody could buy. Gated: bots.fixes.marketMakerIncrementalBid.
  if (fixes.marketMakerIncrementalBid) {
    target = Math.max(0, target - session.creditsHeld(bot.id))
  }
  if (target <= 0) return false
  // Bid above the discovered reference (to win inventory), capped at P and dispersed.
  const price = disperse(Math.min(P, referencePrice(session) * cfg.auctionAggr), ctx.rt.bias ?? 0, P)
  return trySubmitBid(session, bot.id, target, price)
}

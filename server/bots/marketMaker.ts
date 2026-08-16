import { buildMarketView } from '../../shared/engine'
import {
  anchorValue,
  botAvgCost,
  cancelAllOrders,
  clamp,
  sellCapacity,
  tryPlace,
  trySell,
  trySubmitBid,
} from './helpers'
import {
  MM_AUCTION_PRICE_FRAC,
  MM_INV_FRAC,
  MM_MIN_MARGIN,
  MM_QUOTE_SIZE,
  MM_SKEW,
  MM_SKEW_CAP_FRAC,
  MM_SPREAD_FRAC,
  type BotCtx,
} from './types'

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
  const P = session.state.config.penaltyRate

  // Clear stale quotes first so the book's best reflects real (non-self) liquidity.
  cancelAllOrders(session, record, bot.id)
  const mv = buildMarketView(record.orders, record.trades)

  const anchor = anchorValue(mv, P)
  const margin = Math.max(MM_MIN_MARGIN, MM_SPREAD_FRAC * anchor)
  const target = MM_INV_FRAC * record.regulatorPool
  const held = session.creditsHeld(bot.id)
  const skewCap = MM_SKEW_CAP_FRAC * P
  const skew = clamp(MM_SKEW * (held - target), -skewCap, skewCap)
  const center = anchor - skew
  const avg = botAvgCost(record, bot.id)
  const askFloor = avg !== null ? avg + MM_MIN_MARGIN : center + margin

  let acted = false

  // Opportunistic: lift an ask cheaper than centre (buy cheap)…
  if (mv.bestAsk !== null && mv.bestAsk < center) {
    acted = tryPlace(session, bot.id, 'buy', MM_QUOTE_SIZE, mv.bestAsk) || acted
  }
  // …and hit a bid richer than centre, but never below our profit floor (sell rich).
  if (mv.bestBid !== null && mv.bestBid > center && mv.bestBid >= askFloor) {
    acted = trySell(session, record, bot.id, MM_QUOTE_SIZE, mv.bestBid) || acted
  }

  // Rest fresh two-sided quotes around the inventory-shifted centre.
  const bid = clamp(center - margin, 0.1, P - 0.1)
  acted = tryPlace(session, bot.id, 'buy', MM_QUOTE_SIZE, bid) || acted
  const ask = Math.max(center + margin, askFloor)
  if (sellCapacity(session, record, bot.id) > 0) {
    acted = trySell(session, record, bot.id, MM_QUOTE_SIZE, ask) || acted
  }
  return acted
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.penaltyRate
  const target = MM_INV_FRAC * record.regulatorPool // deep inventory to two-side the market
  if (target <= 0) return false
  return trySubmitBid(session, bot.id, target, MM_AUCTION_PRICE_FRAC * P)
}

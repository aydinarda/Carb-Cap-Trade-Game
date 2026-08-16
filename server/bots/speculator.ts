import { buildMarketView } from '../../shared/engine'
import { tryPlace, trySell, trySubmitBid } from './helpers'
import { MOM_EPS, SPEC_INIT_INV, SPEC_SIZE, type BotCtx } from './types'

/**
 * Speculator (momentum, ~0 emissions). Buys into upticks and sells into downticks —
 * amplifying moves. Bounded by no-shorting and finite inventory, so it can push the
 * price around but not run it away; the compliance/MM arbitrage corrects overshoots.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot, rt } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.penaltyRate
  const mv = buildMarketView(record.orders, record.trades)
  const last = mv.lastPrice ?? mv.vwap
  const prev = rt.lastSeenPrice
  if (last !== null) rt.lastSeenPrice = last
  if (last === null || prev === undefined) return false

  if (last > prev * (1 + MOM_EPS)) {
    if (mv.bestAsk !== null && mv.bestAsk < P) {
      return tryPlace(session, bot.id, 'buy', SPEC_SIZE, mv.bestAsk) // ride the uptrend
    }
  } else if (last < prev * (1 - MOM_EPS)) {
    if (mv.bestBid !== null) {
      return trySell(session, record, bot.id, SPEC_SIZE, mv.bestBid) // sell the downtrend
    }
  }
  return false
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const P = session.state.config.penaltyRate
  return trySubmitBid(session, bot.id, SPEC_INIT_INV, 0.5 * P) // modest inventory to trade later
}

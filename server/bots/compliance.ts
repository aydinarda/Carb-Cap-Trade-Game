import { buildMarketView, expectedEmission, optimalAbatement, round1 } from '../../shared/engine'
import { GameError } from '../session'
import { marketMid, tryPlace, trySell, trySubmitBid } from './helpers'
import type { BotCtx } from './types'

/**
 * Compliance firm — a real emitter that plays fundamentals and thereby anchors the
 * price. It abates to the cost-minimising point, then covers its residual near fair
 * value (min(penaltyRate, MAC)), lifting asks cheaper than fair and hitting bids
 * richer than fair — the arbitrage that pulls the market back to fundamentals.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.penaltyRate
  const coeff = session.state.config.abatement[bot.industry]
  const mv = buildMarketView(record.orders, record.trades)
  const mid = marketMid(mv, P)
  const rStar = optimalAbatement(coeff, mid)
  try {
    session.setAbatement(bot.id, rStar)
  } catch (e) {
    if (!(e instanceof GameError)) throw e
  }
  const fair = Math.min(P, coeff.a + coeff.b * rStar)
  const expected = expectedEmission(bot, record.year)
  const held = session.creditsHeld(bot.id)
  const need = round1(expected * (1 - rStar) - held)

  if (need > 0.5) {
    if (mv.bestAsk !== null && mv.bestAsk < fair) {
      return tryPlace(session, bot.id, 'buy', need, mv.bestAsk) // lift a cheap ask
    }
    return tryPlace(session, bot.id, 'buy', need, fair - 0.1) // rest a bid at fair
  }
  if (need < -0.5) {
    const surplus = -need
    if (mv.bestBid !== null && mv.bestBid > fair) {
      return trySell(session, record, bot.id, surplus, mv.bestBid) // hit a rich bid
    }
    return trySell(session, record, bot.id, surplus, fair + 0.1)
  }
  return false
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.penaltyRate
  const coeff = session.state.config.abatement[bot.industry]
  const rStar = optimalAbatement(coeff, P)
  const fair = Math.min(P, coeff.a + coeff.b * rStar)
  const expected = expectedEmission(bot, record.year)
  const held = session.creditsHeld(bot.id)
  const residual = round1(expected * (1 - rStar) - held)
  if (residual <= 0) return false
  return trySubmitBid(session, bot.id, residual, fair)
}

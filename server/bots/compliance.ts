import {
  buildMarketView,
  expectedEmission,
  marginalCost,
  optimalAbatement,
  round1,
  type AbatementSpec,
} from '../../shared/engine'
import { GameError } from '../session'
import { disperse, marketMid, referencePrice, tryPlace, trySell, trySubmitBid } from './helpers'
import type { BotCtx } from './types'

/**
 * Willingness to pay for a tonne the firm cannot cover. Its alternatives to buying
 * are cutting the tonne itself or paying the penalty, so it will pay up to the
 * cheaper of the two. `rCover` is the abatement fraction that would close the gap
 * outright; if even a 100% cut leaves it short, the penalty is the binding
 * alternative and it should bid all the way up to it.
 *
 * This matters most under a free-allocation mode with a tight benchmark: the class
 * is structurally short, and without the penalty ceiling in view every bot would
 * anchor on the same stale mid and the market would be slow to price the scarcity.
 */
function reservationPrice(
  expected: number,
  held: number,
  coeff: AbatementSpec,
  penaltyRate: number,
): number {
  if (expected <= 0) return penaltyRate
  const rCover = 1 - held / expected
  if (rCover >= 1) return penaltyRate
  return Math.min(penaltyRate, marginalCost(Math.max(0, rCover), coeff))
}

/**
 * Compliance firm — a real emitter that plays fundamentals and thereby anchors the
 * price. It abates to the cost-minimising point, then covers its residual at its
 * reservation price (the cheaper of cutting the tonne itself and paying the
 * penalty), lifting asks below that and hitting bids richer than its own MAC — the
 * arbitrage that pulls the market back to fundamentals.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.market.penaltyRate
  const cfg = session.state.config.bots.compliance
  const coeff = session.state.config.abatement.sectors[bot.industry]
  const mv = buildMarketView(record.orders, record.trades)
  const mid = marketMid(mv, referencePrice(session))
  const rStar = optimalAbatement(coeff, mid)
  try {
    session.setAbatement(bot.id, rStar)
  } catch (e) {
    if (!(e instanceof GameError)) throw e
  }
  const fair = Math.min(P, marginalCost(rStar, coeff))
  const fairB = disperse(fair, ctx.rt.bias ?? 0, P) // personality-shifted fair value
  const expected = expectedEmission(bot, record.year)
  const held = session.creditsHeld(bot.id)
  const need = round1(expected * (1 - rStar) - held)

  if (need > cfg.minTradeSize) {
    // Short after abating: bid at what the shortfall is actually worth to us, which
    // rises toward the penalty the further we are from covering it.
    const reservation = reservationPrice(expected, held, coeff, P)
    const reservationB = disperse(reservation, ctx.rt.bias ?? 0, P)
    if (mv.bestAsk !== null && mv.bestAsk < reservation) {
      return tryPlace(session, bot.id, 'buy', need, mv.bestAsk) // lift a cheap ask
    }
    return tryPlace(session, bot.id, 'buy', need, reservationB - cfg.priceStep)
  }
  if (need < -cfg.minTradeSize) {
    const surplus = -need
    if (mv.bestBid !== null && mv.bestBid > fair) {
      return trySell(session, record, bot.id, surplus, mv.bestBid) // hit a rich bid
    }
    return trySell(session, record, bot.id, surplus, fairB + cfg.priceStep)
  }
  return false
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = session.state.config.market.penaltyRate
  const coeff = session.state.config.abatement.sectors[bot.industry]
  const ref = referencePrice(session)
  // Abate to the market-implied point; the residual is what it still needs to buy.
  const rStar = optimalAbatement(coeff, ref)
  const expected = expectedEmission(bot, record.year)
  const held = session.creditsHeld(bot.id)
  const residual = round1(expected * (1 - rStar) - held)
  if (residual <= 0) return false
  // An allowance is a tradeable asset worth ~the market price — bid at the reference,
  // not the private MAC, so the clearing price tracks the discovered price.
  return trySubmitBid(session, bot.id, residual, disperse(Math.min(P, ref), ctx.rt.bias ?? 0, P))
}

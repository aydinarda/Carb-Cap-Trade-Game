import { buildMarketView, expectedEmission, optimalAbatement } from '../../shared/engine'
import { anchorValue, clamp, referencePrice, tryPlace, trySell, trySubmitBid } from './helpers'
import { NOISE_ERR, NOISE_PRICE_JITTER, NOISE_SIZE, NOISE_SKIP, type BotCtx } from './types'

/**
 * Noise trader — a small emitter with the same compliance objective (cover its own
 * position) but error-prone execution and small size: it usually leans the right
 * way, but occasionally flips side and always jitters its price. Provides the messy
 * realism and cheap/rich orders that the arbitrageurs feed on.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot, rng } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  if (rng.next() < NOISE_SKIP) return false
  const P = session.state.config.penaltyRate
  const coeff = session.state.config.abatement[bot.industry]
  const mv = buildMarketView(record.orders, record.trades)
  const anchor = anchorValue(mv, referencePrice(session))
  const rStar = optimalAbatement(coeff, anchor)
  const fair = Math.min(P, coeff.a + coeff.b * rStar)
  const expected = expectedEmission(bot, record.year)
  const held = session.creditsHeld(bot.id)
  const need = expected * (1 - rStar) - held

  let side: 'buy' | 'sell' = need > 0 ? 'buy' : 'sell'
  if (rng.next() < NOISE_ERR) side = side === 'buy' ? 'sell' : 'buy' // occasional wrong side
  // Persistent personality bias + per-tick jitter → erratic but centred on value.
  const bias = ctx.rt.bias ?? 0
  const price = clamp(fair * (1 + bias + rng.uniform(-NOISE_PRICE_JITTER, NOISE_PRICE_JITTER)), 0.1, P)
  const qty = NOISE_SIZE * rng.uniform(0.5, 1.5)

  if (side === 'sell') return trySell(session, record, bot.id, qty, price)
  return tryPlace(session, bot.id, 'buy', qty, price)
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot, rng } = ctx
  const P = session.state.config.penaltyRate
  // Anchored to the discovered price (an allowance's resale value), with noise.
  const ref = referencePrice(session)
  const price = clamp(ref * (1 + (ctx.rt.bias ?? 0) + rng.uniform(-0.1, 0.1)), 0.1, P)
  return trySubmitBid(session, bot.id, NOISE_SIZE, price) // small auction buy
}

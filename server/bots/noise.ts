import {
  buildMarketView,
  expectedEmission,
  marginalCost,
  optimalAbatement,
} from '../../shared/engine'
import { anchorValue, clamp, referencePrice, tryPlace, trySell, trySubmitBid } from './helpers'
import type { BotCtx } from './types'

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
  const cfg = session.state.config.bots.noise
  if (rng.next() < cfg.skipRate) return false
  const P = session.state.config.market.penaltyRate
  const minPrice = session.state.config.bots.minPrice
  const coeff = session.state.config.abatement.sectors[bot.industry]
  const mv = buildMarketView(record.orders, record.trades)
  const anchor = anchorValue(mv, referencePrice(session))
  const rStar = optimalAbatement(coeff, anchor)
  const fair = Math.min(P, marginalCost(rStar, coeff))
  const expected = expectedEmission(bot, record.year)
  const held = session.creditsHeld(bot.id)
  const need = expected * (1 - rStar) - held

  let side: 'buy' | 'sell' = need > 0 ? 'buy' : 'sell'
  if (rng.next() < cfg.errorRate) side = side === 'buy' ? 'sell' : 'buy' // occasional wrong side
  // Persistent personality bias + per-tick jitter → erratic but centred on value.
  const bias = ctx.rt.bias ?? 0
  const price = clamp(fair * (1 + bias + rng.uniform(-cfg.priceJitter, cfg.priceJitter)), minPrice, P)
  const qty = cfg.size * rng.uniform(1 - cfg.sizeJitter, 1 + cfg.sizeJitter)

  if (side === 'sell') return trySell(session, record, bot.id, qty, price)
  return tryPlace(session, bot.id, 'buy', qty, price)
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot, rng } = ctx
  const P = session.state.config.market.penaltyRate
  const cfg = session.state.config.bots.noise
  const minPrice = session.state.config.bots.minPrice
  // Anchored to the discovered price (an allowance's resale value), with noise.
  const ref = referencePrice(session)
  const price = clamp(
    ref * (1 + (ctx.rt.bias ?? 0) + rng.uniform(-cfg.auctionJitter, cfg.auctionJitter)),
    minPrice,
    P,
  )
  return trySubmitBid(session, bot.id, cfg.size, price) // small auction buy
}

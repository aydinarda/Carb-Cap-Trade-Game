import { marginalCost, optimalAbatement } from '../../shared/engine'
import {
  anchorValue,
  clamp,
  considerInstall,
  priceCeiling,
  referencePrice,
  sellCapacity,
  syncQuote,
  trySubmitBid,
} from './helpers'
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
  const P = priceCeiling(session)
  const minPrice = session.state.config.bots.minPrice
  const coeff = session.state.config.abatement.sectors[bot.industry]
  const mv = ctx.market
  const anchor = anchorValue(mv, referencePrice(session))
  const rStar = optimalAbatement(coeff, anchor)
  // Whether this archetype invests in abatement capacity at all. The original bug this
  // flag guarded is gone — sizing now reads `plannedEmission`, so the bot can no longer
  // trade as though it had cut while its recorded abatement stayed 0. What remains is a
  // genuine behavioural question: is a careless trader also a firm that never retrofits?
  // Gated: see bots.fixes.noiseAbatement.
  if (session.state.config.bots.fixes.noiseAbatement) {
    considerInstall(session, bot.id, ctx.rt, anchor)
  }
  const fair = Math.min(P, marginalCost(rStar, coeff))
  const planned = session.plannedEmission(bot.id)
  const held = session.creditsHeld(bot.id)
  const need = planned - held

  let side: 'buy' | 'sell' = need > 0 ? 'buy' : 'sell'
  if (rng.next() < cfg.errorRate) side = side === 'buy' ? 'sell' : 'buy' // occasional wrong side
  // Persistent personality bias + per-tick jitter → erratic but centred on value.
  const bias = ctx.rt.bias ?? 0
  const price = clamp(fair * (1 + bias + rng.uniform(-cfg.priceJitter, cfg.priceJitter)), minPrice, P)
  const qty = cfg.size * rng.uniform(1 - cfg.sizeJitter, 1 + cfg.sizeJitter)

  // Still erratic, but it replaces its own stale order instead of stacking a new one on
  // top every tick — the churn is what inflated the book, not the noise itself.
  if (side === 'sell') {
    const room = sellCapacity(session, record, bot.id)
    if (room <= 0) return false
    return syncQuote(session, record, bot.id, ctx.rt, 'sell', Math.min(qty, room), price)
  }
  return syncQuote(session, record, bot.id, ctx.rt, 'buy', qty, price)
}

/**
 * A small, sloppy compliance bid — sloppy about PRICE, not about position.
 *
 * It used to bid a flat `cfg.size` whatever it already held, while its own `trade()` sized
 * off `planned − held` two lines away. That inconsistency is not the archetype's carelessness
 * — a noise trader mis-prices and occasionally takes the wrong side, it does not forget it
 * owns things — and it shows up plainly under a regime that issues part of the cap free,
 * where a bot that has just been handed its benchmark still bids as though it had nothing.
 * The jitter and the personality bias stay: the error belongs in the price.
 */
export function auction(ctx: BotCtx): boolean {
  const { session, bot, rng } = ctx
  const P = priceCeiling(session)
  const cfg = session.state.config.bots.noise
  const minPrice = session.state.config.bots.minPrice
  const residual = session.plannedEmission(bot.id) - session.creditsHeld(bot.id)
  if (residual <= 0) return false
  // Still small and still a fixed lot — capped by what it actually needs.
  const qty = Math.min(cfg.size, residual)
  // Anchored to the discovered price (an allowance's resale value), with noise.
  const ref = referencePrice(session)
  const price = clamp(
    ref * (1 + (ctx.rt.bias ?? 0) + rng.uniform(-cfg.auctionJitter, cfg.auctionJitter)),
    minPrice,
    P,
  )
  return trySubmitBid(session, bot.id, qty, price) // small auction buy
}

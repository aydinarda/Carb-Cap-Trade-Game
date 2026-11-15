import { round1 } from '../../shared/engine'
import {
  anchorValue,
  auctionReference,
  clamp,
  priceCeiling,
  referencePrice,
  sellCapacity,
  syncQuote,
  trySubmitSweep,
} from './helpers'
import type { BotCtx } from './types'

/**
 * Noise trader — a small emitter with the same compliance objective (cover its own
 * position) but error-prone execution: it usually leans the right way, but occasionally
 * takes the wrong side and always jitters its price. Provides the messy realism and
 * cheap/rich orders that the arbitrageurs feed on.
 *
 * Small for real since 2026-11-13: it sits in the `Noise` sector with a flat
 * `bots.noise.emission` (20 t) a year. It has no abatement curve, so it never installs
 * (`fixes.noiseAbatement` has no effect).
 *
 * Its target is to hold what it will emit, and it ASKS FOR WHAT IT NEEDS (the user,
 * 2026-11-15): this round's planned emission less everything it holds, at the auction and in
 * the market alike. A shortfall carried in from earlier rounds is inside `creditsHeld`
 * (negative), so the debt is part of the demand. It used to order a fixed `size` lot whatever
 * it was short of — at most 4 t at the auction against a need of 20 t and more — so it never
 * covered, rolled a growing debt, and was fined for the same tonnes every round. The noise is
 * in the price, the timing and the occasional wrong-side slip, not in how much it wants.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot, rng } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const cfg = session.state.config.bots.noise
  if (rng.next() < cfg.skipRate) return false
  const P = priceCeiling(session)
  const minPrice = session.state.config.bots.minPrice
  const mv = ctx.market
  // Its fair value is the market's anchor. It used to be the MAC at the cut the anchor makes
  // worthwhile, which is the anchor itself wherever that cut is inside the cap; the `Noise`
  // sector has no abatement curve, so the anchor is what is left.
  const fair = Math.min(P, anchorValue(mv, referencePrice(session)))
  // Positive: what it still has to get. Negative: what it holds beyond its emission.
  const need = round1(session.plannedEmission(bot.id) - session.creditsHeld(bot.id))

  const wrongSide = rng.next() < cfg.errorRate // occasional wrong side
  // Persistent personality bias + per-tick jitter → erratic but centred on value.
  const bias = ctx.rt.bias ?? 0
  const price = clamp(fair * (1 + bias + rng.uniform(-cfg.priceJitter, cfg.priceJitter)), minPrice, P)
  // The size of a MISTAKE only: a wrong-side order is one small lot. The right-side order is
  // the need itself. Drawn every tick either way, so the seeded stream does not depend on
  // which side the bot ended up on.
  const slip = cfg.size * rng.uniform(1 - cfg.sizeJitter, 1 + cfg.sizeJitter)

  const rightSide: 'buy' | 'sell' = need > 0 ? 'buy' : 'sell'
  const side: 'buy' | 'sell' = wrongSide ? (rightSide === 'buy' ? 'sell' : 'buy') : rightSide
  const qty = wrongSide ? slip : Math.abs(need)
  if (!(qty > 0)) return false // exactly covered, and no slip this tick

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
 * A sloppy compliance bid for everything it needs — sloppy about PRICE, not about position.
 *
 * It asks for its whole residual: planned emission less what it holds, a carried debt
 * included. Until 2026-11-15 the bid was capped at one `size` lot (4 t), a fifth of a year's
 * need at best, and split over a five-step sweep on top of that.
 * The jitter and the personality bias stay: the error belongs in the price.
 */
export function auction(ctx: BotCtx): boolean {
  const { session, bot, rng } = ctx
  const P = priceCeiling(session)
  const cfg = session.state.config.bots.noise
  const minPrice = session.state.config.bots.minPrice
  const residual = round1(session.plannedEmission(bot.id) - session.creditsHeld(bot.id))
  if (residual <= 0) return false
  // Anchored to the auction's reference point (`bots.reference`), with noise.
  const ref = auctionReference(session)
  const price = clamp(
    ref * (1 + (ctx.rt.bias ?? 0) + rng.uniform(-cfg.auctionJitter, cfg.auctionJitter)),
    minPrice,
    P,
  )
  return trySubmitSweep(session, bot, residual, price)
}

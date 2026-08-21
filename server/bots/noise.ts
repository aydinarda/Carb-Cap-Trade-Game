import {
  expectedEmission,
  marginalCost,
  optimalAbatement,
} from '../../shared/engine'
import { GameError } from '../session'
import {
  anchorValue,
  clamp,
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
  const P = session.state.config.market.penaltyRate
  const minPrice = session.state.config.bots.minPrice
  const coeff = session.state.config.abatement.sectors[bot.industry]
  const mv = ctx.market
  const anchor = anchorValue(mv, referencePrice(session))
  const rStar = optimalAbatement(coeff, anchor)
  // Without this the bot prices and sizes its order as though it had cut to r*, while its
  // recorded abatement stays 0 — so it is short by `expected × rStar` at settlement every
  // single year. Gated: see bots.fixes.noiseAbatement.
  if (session.state.config.bots.fixes.noiseAbatement) {
    try {
      session.setAbatement(bot.id, rStar)
    } catch (e) {
      if (!(e instanceof GameError)) throw e
    }
  }
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

  // Still erratic, but it replaces its own stale order instead of stacking a new one on
  // top every tick — the churn is what inflated the book, not the noise itself.
  if (side === 'sell') {
    const room = sellCapacity(session, record, bot.id)
    if (room <= 0) return false
    return syncQuote(session, record, bot.id, ctx.rt, 'sell', Math.min(qty, room), price)
  }
  return syncQuote(session, record, bot.id, ctx.rt, 'buy', qty, price)
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

import { buildMarketView, round1 } from '../../shared/engine'
import {
  clamp,
  disperse,
  priceCeiling,
  recentPrice,
  sellCapacity,
  syncQuote,
  tryPlace,
  trySell,
  trySubmitBid,
} from './helpers'
import type { BotCtx } from './types'

/**
 * Market maker (financial player, ~0 emissions).
 *
 * Quotes a fixed band either side of the recent traded price: it buys within
 * `[ref·(1−bandFrac), ref]` and sells within `[ref, ref·(1+bandFrac)]`, leaning to the low
 * end of the band when it is long and the high end when it is short. Because both sides are
 * pinned to where the market is actually trading, it cannot walk the price away from the
 * class — and it cannot stop offering just because it is holding a lot.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = priceCeiling(session)
  const cfg = session.state.config.bots.marketMaker
  const minPrice = session.state.config.bots.minPrice

  // The maker prices against liquidity it can actually take: not its own resting quotes
  // (it would chase itself), and not any other market maker's (the engine refuses
  // maker-to-maker fills — see Session.blockedPair). Without the second exclusion it would
  // repeatedly lift an ask that can never fill and leave the order resting instead.
  const makerIds = new Set(
    session.state.players.filter((p) => p.botType === 'marketMaker').map((p) => p.id),
  )
  const mv = buildMarketView(
    record.orders.filter((o) => !makerIds.has(o.playerId)),
    record.trades,
  )

  // The maker quotes AROUND WHERE THE MARKET IS TRADING, never away from it: the mean of
  // the last few prints, with a fixed band either side. It buys in [ref·(1−band), ref] and
  // sells in [ref, ref·(1+band)] — so every fill it takes is on the right side of the
  // recent price by construction.
  //
  // This replaces an inventory-skewed centre (`anchor − skew`, skew up to ±0.4·P). That let
  // a maker holding a large position quote a centre tens of euros below the market and stop
  // offering entirely, which is how makers ended up sitting on seven years of issuance while
  // the price stayed pinned near the ceiling.
  const ref = recentPrice(session, record, cfg.recentTrades)
  const band = cfg.bandFrac
  const target = cfg.invFrac * session.circulatingCap()
  const held = session.creditsHeld(bot.id)
  const skewCap = cfg.skewCapFrac * P

  // Where inside the band we sit. 0 = long (bid low, offer at ref: shed inventory),
  // 1 = short (bid at ref, offer high: acquire). Personality nudges it so makers do not tie.
  const skew = clamp(cfg.skew * (held - target), -skewCap, skewCap)
  const lean = clamp(0.5 - 0.5 * (skew / (skewCap || 1)) + (ctx.rt.bias ?? 0), 0, 1)

  const bid = clamp(round1(ref * (1 - band * (1 - lean))), minPrice, P)
  const ask = clamp(round1(ref * (1 + band * lean)), minPrice, P)

  let acted = false

  // Opportunistic legs, held to the same rule: only buy at or below the recent price, only
  // sell at or above it. Without this gate "everything it sells" would not be inside the band.
  if (mv.bestAsk !== null && mv.bestAsk <= ref) {
    acted = tryPlace(session, bot.id, 'buy', cfg.quoteSize, mv.bestAsk) || acted
  }
  if (mv.bestBid !== null && mv.bestBid >= ref) {
    acted = trySell(session, record, bot.id, cfg.quoteSize, mv.bestBid) || acted
  }

  // Rest both sides. `syncQuote` leaves an already-correct quote alone, so a quiet market
  // costs nothing.
  acted = syncQuote(session, record, bot.id, ctx.rt, 'buy', cfg.quoteSize, bid) || acted
  const room = sellCapacity(session, record, bot.id)
  if (room > 0) {
    acted =
      syncQuote(session, record, bot.id, ctx.rt, 'sell', Math.min(cfg.quoteSize, room), ask) || acted
  }
  return acted
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = priceCeiling(session)
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
  // Same rule as the resting quotes: a maker buys at or below the recent price, never above
  // it. An earlier version bid `reference × 1.3` — 30% over the market — which is how four
  // makers took 72% of the pool before any emitter got a look at it. The knob that drove it
  // (`bots.marketMaker.auctionAggr`) was deleted rather than left at a value nothing reads:
  // a config field the engine ignores is one somebody eventually sweeps for a day.
  //
  // What DOES move this bid: `bandFrac` (how far under the reference it may sit) and
  // `invFrac` (the target, and so the quantity).
  const ref = recentPrice(session, record, cfg.recentTrades)
  const price = clamp(
    disperse(ref, ctx.rt.bias ?? 0, P),
    ref * (1 - cfg.bandFrac),
    ref,
  )
  return trySubmitBid(session, bot.id, target, round1(price))
}

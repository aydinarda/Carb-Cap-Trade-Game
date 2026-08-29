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
/**
 * A single maker's target inventory: its share of the pool, split between the makers when
 * `marketMakerShareByCount` is on. Defined once because both the quote and the auction bid
 * must read the identical number.
 */
function makerTarget(session: BotCtx['session'], invFrac: number): number {
  let target = invFrac * session.circulatingCap()
  if (session.state.config.bots.fixes.marketMakerShareByCount) {
    const makers = session.state.players.filter((p) => p.botType === 'marketMaker').length
    if (makers > 1) target /= makers
  }
  return target
}

export function trade(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = priceCeiling(session)
  const cfg = session.state.config.bots.marketMaker
  const minPrice = session.state.config.bots.minPrice

  // Sit out the opening of the year: no quotes, no lifts, nothing.
  //
  // The maker prices off `recentPrice`, which before any print this year is last year's
  // reference — so quoting from tick one carries the old price into the new year and every
  // other bot then prices off the maker. The class opens the year; the maker joins once
  // there is a market to make.
  if (ctx.rt.tradeTicksYear !== record.year) {
    ctx.rt.tradeTicksYear = record.year
    ctx.rt.tradeTicks = 0
  }
  ctx.rt.tradeTicks = (ctx.rt.tradeTicks ?? 0) + 1
  if (ctx.rt.tradeTicks <= cfg.quietTicks) return false

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
  // The SAME target the auction bids to — `marketMakerShareByCount` divides it between the
  // makers there, and this read has to agree or the two halves of one bot contradict each
  // other. They did: the auction bought to invFrac/N of the pool while the quote priced
  // against invFrac of it, so a maker holding exactly what it had just been told to buy
  // still read itself as three quarters short. That pins `lean` near 1 — bid at the
  // reference, offer at the top of the band — which is a maker that only ever wants to
  // acquire, and is why the offer side of the book stayed empty.
  const target = makerTarget(session, cfg.invFrac)
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
  const minPrice = session.state.config.bots.minPrice
  const fixes = session.state.config.bots.fixes
  // Same helper the quote uses. Without `marketMakerShareByCount` every maker sizes off the
  // WHOLE pool, so N makers chase N × invFrac of it — four of them bid 72% of the cap.
  let target = makerTarget(session, cfg.invFrac)
  // `marketMakerIncrementalBid` subtracts what the maker already holds, which is what made
  // it stop bidding once its target was met. Kept as a flag so the two behaviours can still
  // be compared on identical seeds, but it is OFF by default now: a maker that withdraws from
  // the auction has no book to sell from for the rest of the game.
  if (fixes.marketMakerIncrementalBid) {
    target = Math.max(0, target - session.creditsHeld(bot.id))
  }
  if (target <= 0) return false
  // Bids its FULL target at a premium over the reference, rather than the gap at or under it.
  //
  // The previous rule did the opposite on both counts and the maker stopped participating:
  // it bid only `target − held`, which is zero once the target is met, and never above the
  // reference, which loses to any emitter covering itself. Measured, it took 18% of the pool
  // in year one and 0-2% in every year after, while the offer side of the book thinned out.
  //
  // The cost of this is real and is the reason the incremental rule existed: bidding the full
  // target every year lets inventory compound. `marketMakerShareByCount` divides the target
  // between the makers, which is what keeps that bounded.
  const ref = recentPrice(session, record, cfg.recentTrades)
  const price = clamp(
    disperse(ref * (1 + cfg.auctionPremium), ctx.rt.bias ?? 0, P),
    minPrice,
    P,
  )
  return trySubmitBid(session, bot.id, target, round1(price))
}

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
  //
  // `extraPass` marks a repeat call inside the SAME tick (see `actionsPerTick`). The counter
  // must not advance on those, or three passes per tick would burn the quiet window in a
  // third of the ticks it is meant to last.
  if (!ctx.extraPass) {
    if (ctx.rt.tradeTicksYear !== record.year) {
      ctx.rt.tradeTicksYear = record.year
      ctx.rt.tradeTicks = 0
    }
    ctx.rt.tradeTicks = (ctx.rt.tradeTicks ?? 0) + 1
  }
  if ((ctx.rt.tradeTicks ?? 0) <= cfg.quietTicks) return false

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
    // The ask carries the inventory the maker is trying to work off, not a fixed lot.
    //
    // A maker wins its whole target at the auction in one go and then offers it back 15
    // tonnes at a time, which is not a rate at which anything can be worked off: measured
    // over ten years it bought ~1 100 a year and shed almost none, ending on 10 677. Adding
    // a share of the EXCESS over target makes the offer proportional to the problem, and
    // leaves a maker sitting at its target quoting exactly what it always did.
    const excess = Math.max(0, held - target)
    const askSize = Math.min(round1(cfg.quoteSize + excess * cfg.excessShedFrac), room)
    acted = syncQuote(session, record, bot.id, ctx.rt, 'sell', askSize, ask) || acted
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
  // Bid the GAP to target, not the target again.
  //
  // Buying a full target every year is only sustainable for something that consumes what it
  // buys, and a maker emits nothing: measured, it won ~1 100 tonnes a year and shed ~140, so
  // holdings ran to nine times target by year 20 and were then stranded worthless by the
  // end-of-game rule.
  //
  // This was OFF for a while, because on its own it retires the maker — bid the gap, hit the
  // target once, and never bid again. What makes it work now is `excessShedFrac`: the maker
  // offers its excess back, falls below target, and re-bids for the difference. The two are
  // one mechanism, and turning either off alone reproduces the failure the other was for.
  if (fixes.marketMakerIncrementalBid) {
    target = Math.max(0, target - session.creditsHeld(bot.id))
  }
  if (target <= 0) return false
  // Priced at a premium over the reference: the maker is buying a book to sell from, so it
  // has to outbid the emitters that only want to cover themselves. Bidding at or under the
  // reference loses every auction to a firm with a compliance obligation.
  const ref = recentPrice(session, record, cfg.recentTrades)
  const price = clamp(
    disperse(ref * (1 + cfg.auctionPremium), ctx.rt.bias ?? 0, P),
    minPrice,
    P,
  )
  return trySubmitBid(session, bot.id, target, round1(price))
}

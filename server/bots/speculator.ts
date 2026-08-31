import {
  disperse,
  priceCeiling,
  referencePrice,
  tryPlace,
  trySell,
  trySubmitBid,
} from './helpers'
import type { BotCtx } from './types'

/**
 * Speculator (momentum, ~0 emissions). Buys into upticks and sells into downticks —
 * amplifying moves. Bounded by no-shorting and finite inventory, so it can push the
 * price around but not run it away; the compliance/MM arbitrage corrects overshoots.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot, rt } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = priceCeiling(session)
  const cfg = session.state.config.bots.speculator
  const mv = ctx.market
  const last = mv.lastPrice ?? mv.vwap
  const prev = rt.lastSeenPrice
  if (last !== null) rt.lastSeenPrice = last
  if (last === null || prev === undefined) return false

  if (last > prev * (1 + cfg.momentumEps)) {
    if (mv.bestAsk !== null && mv.bestAsk < P) {
      return tryPlace(session, bot.id, 'buy', cfg.size, mv.bestAsk) // ride the uptrend
    }
  } else if (last < prev * (1 - cfg.momentumEps)) {
    if (mv.bestBid !== null) {
      return trySell(session, record, bot.id, cfg.size, mv.bestBid) // sell the downtrend
    }
  }
  return false
}

/**
 * The opening book, bought once.
 *
 * `initialInventory` is what its name says — a starting position, not an annual order. It
 * used to be bid at EVERY auction regardless of what the speculator already held, and since
 * a speculator emits nothing and only sells into a downtick, that was a one-way ratchet:
 * measured over ten years it bought 15 tonnes a year and never worked them off, ending on
 * 142. A momentum trader that accumulates whatever the calendar hands it is not trading on
 * momentum; from year two it builds its position in the market, which is the archetype.
 */
export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record || record.year !== session.state.config.emissions.firstGameYear) return false
  const P = priceCeiling(session)
  const cfg = session.state.config.bots.speculator
  // Anchor to the discovered price (not a static 0.5·P) so the clearing tracks the
  // market year to year; disperse by personality so speculators don't tie.
  const price = disperse(referencePrice(session), ctx.rt.bias ?? 0, P)
  return trySubmitBid(session, bot.id, cfg.initialInventory, price)
}

import {
  marginalCost,
  optimalAbatement,
  round1,
  type AbatementSpec,
} from '../../shared/engine'
import {
  considerInstall,
  disperse,
  marketMid,
  priceCeiling,
  referencePrice,
  sellCapacity,
  syncQuote,
  tryPlace,
  trySell,
  trySubmitBid,
} from './helpers'
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
 *
 * KNOWN WEAKENING, measured rather than patched. Since abatement capacity takes a year to
 * come online, cutting a tonne is no longer an alternative to buying it *this* year —
 * within a year supply and demand are both fixed, and the MAC only bites through next
 * year's investment. So this anchor is now an approximation: the firm behaves as though it
 * could still substitute, which keeps the price tethered to fundamentals rather than
 * swinging between ~0 and the fine on pure scarcity. The formula is deliberately unchanged;
 * the size of the distortion is quantified in the notebook (SR vs LR efficient price).
 */
/**
 * Auction bids value the deepest ALLOWED cut rather than the fine, when the firm cannot
 * self-cover. Temporary switch while the two are compared — see the measurement in the
 * session notes; flip to false for the strict "the fine is the alternative" reading.
 */
const SOFTEN_AT_CAP = true

function reservationPrice(
  expected: number,
  held: number,
  coeff: AbatementSpec,
  penaltyRate: number,
  strictBoundary = false,
  lifetimeCap = 1,
  softenAtCap = false,
): number {
  if (expected <= 0) return penaltyRate
  const rCover = 1 - held / expected
  // At rCover === 1 the firm holds nothing but a full cut still covers it, so the right
  // reservation is the cost of that cut — min(P, MAC(1)) — not the penalty. Only rCover > 1
  // means even a 100% cut leaves it short. Under auctioning `held` starts at 0 every year,
  // so the loose boundary put the bot at the ceiling on tick 1 of every trade window.
  // Gated: see bots.fixes.complianceReservation.
  if (strictBoundary ? rCover > 1 : rCover >= 1) return penaltyRate
  // The cut has to be one the firm is ALLOWED to make. Beyond the lifetime cap there is no
  // self-help left, so the alternative to buying is the fine — and the willingness to pay is
  // the ceiling, not a marginal cost the engine would refuse to let it incur.
  if (rCover > lifetimeCap) {
    // Beyond the cap the firm cannot self-cover, so the fine is the binding alternative and
    // its willingness to pay is the ceiling. `softenAtCap` values the deepest cut it IS
    // allowed instead — a sector-specific number rather than one everybody shares, which is
    // what lets the auction clear on a curve instead of a step. See the auction bid.
    return softenAtCap
      ? Math.min(penaltyRate, marginalCost(lifetimeCap, coeff))
      : penaltyRate
  }
  return Math.min(penaltyRate, marginalCost(Math.max(0, rCover), coeff))
}

/**
 * Compliance firm — a real emitter that plays fundamentals and thereby anchors the
 * price. It covers this year's emissions at its reservation price (the cheaper of cutting
 * the tonne itself and paying the penalty), lifting asks below that and hitting bids richer
 * than its own MAC — the arbitrage that pulls the market back to fundamentals — and
 * separately decides once a year whether to buy capacity for the years after this one.
 */
export function trade(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = priceCeiling(session)
  const cfg = session.state.config.bots.compliance
  const coeff = session.state.config.abatement.sectors[bot.industry]
  const mv = ctx.market
  const mid = marketMid(mv, referencePrice(session))
  // Capital investment, decided once a year and effective next year. It does NOT change
  // what this year needs covering — hence `plannedEmission` below rather than a `1 − r*`
  // discount on the expectation.
  considerInstall(session, bot.id, ctx.rt, mid)
  const rStar = optimalAbatement(coeff, mid)
  const fair = Math.min(P, marginalCost(rStar, coeff))
  const fairB = disperse(fair, ctx.rt.bias ?? 0, P) // personality-shifted fair value
  const planned = session.plannedEmission(bot.id)
  const held = session.creditsHeld(bot.id)
  // Two thresholds, not one.
  //
  // It BUYS up to `coverTarget × planned` and SELLS anything above `planned`. A single
  // threshold — buy and sell at the same level — is why the buffer did nothing when it was
  // first added: the firm bought its way up to exactly 1.1× and stopped there, holding a
  // surplus it would only part with above 1.1×, which it could never reach by buying. Fifteen
  // of twenty firms ended up long and not one of them ever posted an offer.
  //
  // Splitting them makes the buffer real inventory: bought at the auction, offered back to
  // the market during the year. It is not churn — the sell branch below only lifts bids above
  // `fair` or rests an ask above it, so the firm parts with the buffer at a profit or not at
  // all.
  const buyTo = round1(planned * cfg.coverTarget - held)
  const sellFrom = round1(planned - held)
  const need = buyTo > cfg.minTradeSize ? buyTo : sellFrom

  if (need > cfg.minTradeSize) {
    // Short after abating: bid at what the shortfall is actually worth to us, which
    // rises toward the penalty the further we are from covering it.
    const reservation = reservationPrice(
      planned, held, coeff, P,
      session.state.config.bots.fixes.complianceReservation,
      session.abatementLifetimeCap,
    )
    const reservationB = disperse(reservation, ctx.rt.bias ?? 0, P)
    if (mv.bestAsk !== null && mv.bestAsk < reservation) {
      return tryPlace(session, bot.id, 'buy', need, mv.bestAsk) // lift a cheap ask
    }
    // `need` is derived from creditsHeld, which counts only EXECUTED trades — an unfilled
    // bid of ours never reduces it, so a plain place stacked a fresh full-size order every
    // tick. syncQuote keeps the one order and only reprices it when our view moves.
    return syncQuote(session, record, bot.id, ctx.rt, 'buy', need, reservationB - cfg.priceStep)
  }
  if (need < -cfg.minTradeSize) {
    const surplus = -need
    if (mv.bestBid !== null && mv.bestBid > fair) {
      return trySell(session, record, bot.id, surplus, mv.bestBid) // hit a rich bid
    }
    const room = sellCapacity(session, record, bot.id)
    if (room <= 0) return false
    return syncQuote(
      session, record, bot.id, ctx.rt, 'sell', Math.min(surplus, room), fairB + cfg.priceStep,
    )
  }
  return false
}

export function auction(ctx: BotCtx): boolean {
  const { session, bot } = ctx
  const record = session.currentYearRecord()
  if (!record) return false
  const P = priceCeiling(session)
  const ref = referencePrice(session)
  // Whatever it invests in now arrives next year, so it buys against this year's planned
  // emissions in full. Capacity bought at the cap stage would still leave THIS year's
  // residual untouched, so the decision is left to the trade stage where the price is
  // actually discovered.
  const cfg = session.state.config.bots.compliance
  const planned = session.plannedEmission(bot.id)
  const held = session.creditsHeld(bot.id)
  // Same buffer as the trade stage: bidding the bare residual is what made these firms
  // structurally incapable of ever holding a surplus.
  const residual = round1(planned * cfg.coverTarget - held)
  if (residual <= 0) return false
  // Bid what the tonne is WORTH TO THIS FIRM, not what the market last paid.
  //
  // The old rule bid `min(P, reference)` — the previous year's price — for the whole
  // residual, which made every bidder post the same number and demand perfectly inelastic.
  // Measured: supply from 1.4x need down to 0.4x, bid-to-cover 0.97 to 2.93, and the clearing
  // price moved 21.9 to 25.5 while the bid distribution did not move at all. An auction whose
  // price cannot answer "how scarce is this?" has no link to the book it is meant to anchor.
  //
  // The reservation price is that answer: the cost of the cut this firm would have to make
  // instead, or the fine when the cut is beyond its lifetime cap. It differs by sector and by
  // how short the firm is, so bids spread out, and the uniform-price auction clears at the
  // marginal buyer's true willingness to pay — which is the fundamental price the secondary
  // market should then discover too.
  const coeff = session.state.config.abatement.sectors[bot.industry]
  const reservation = reservationPrice(
    planned, held, coeff, P,
    session.state.config.bots.fixes.complianceReservation,
    session.abatementLifetimeCap,
    SOFTEN_AT_CAP,
  )
  // Never above what the tonne is worth, and never so far below the market that the firm
  // simply loses the auction and has to buy the same tonne dearer in the book.
  const bid = Math.max(Math.min(P, ref) * 0.9, Math.min(reservation, P))
  return trySubmitBid(session, bot.id, residual, disperse(bid, ctx.rt.bias ?? 0, P))
}

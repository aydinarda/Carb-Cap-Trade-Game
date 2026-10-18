import {
  meanOfLast,
  openSellRemaining,
  planInstall,
  round1,
  tradedCash,
} from '../../shared/engine'
import type { MarketView, Order, OrderSide, Player, YearRecord } from '../../shared/types'
import { bankWeights, sweepWeights } from './sweepShape'
import type { BotRuntime } from './types'
import { GameError, type Session } from '../session'

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * The reference price the bots anchor to this year — the price signal. Once the
 * auction has cleared, THIS year's clearing price is the freshest signal (everyone
 * just paid it for their allowances), so the secondary market anchors there. Before
 * that (cap stage, or the free-allocation modes with no auction) it falls back to the
 * session's opening reference: the previous settled year's discovered price, then to
 * half the penalty as a neutral first-year default.
 */
export function referencePrice(session: Session): number {
  const auctionPrice = session.currentYearRecord()?.auctionPrice
  if (auctionPrice && auctionPrice > 0) return auctionPrice
  return session.openingReference()
}

/**
 * The reference point of a bot's AUCTION bid (`bots.reference`): a weighted look back over the
 * last rounds plus a short trend, instead of the last close alone — one wild round should not
 * re-anchor every bid. Trading keeps `referencePrice`.
 *
 * Early in the game some of those rounds do not exist yet. By default the weights are rescaled
 * over the rounds that do (`missing: 'renormalize'`): the opening value is a placeholder, not a
 * price anyone paid, and averaging it in pulls round 2's bids far below round 1's close.
 * Measured on 400 simulated games, that rule predicts the next round's market price as well as
 * the last close in round 2 (mean error 0.127 × the penalty, against 0.150 for filling with the
 * opening value) and slightly better from round 4 on (0.171 against 0.175).
 */
export function auctionReference(session: Session): number {
  const { reference, minPrice } = session.state.config.bots
  if (!reference.enabled) return session.openingReference()
  const { penaltyRate, openingReferenceFraction } = session.state.config.market
  const opening = penaltyRate * openingReferenceFraction
  // A few extra rounds back, so a round without a price can be stepped over.
  const rounds = session.recentRoundPrices(Math.max(2, reference.weights.length) + 3)
  const known = rounds.filter((p): p is number => p !== null)
  if (known.length === 0) return round1(Math.max(minPrice, opening))
  let level: number
  let trend: number
  if (reference.missing === 'opening') {
    const prices = rounds.slice(0, Math.max(2, reference.weights.length)).map((p) => p ?? opening)
    level = reference.weights.reduce((sum, w, k) => sum + w * prices[k], 0)
    trend = reference.trend * (prices[0] - prices[1])
  } else {
    // The rounds that have a price, most recent first — a round that traded nothing is stepped
    // over, as the plain reference always did — with the weights rescaled over however many
    // there are.
    const prices = known.slice(0, reference.weights.length)
    const used = reference.weights.slice(0, prices.length)
    const total = used.reduce((a, w) => a + w, 0)
    level = total > 0 ? used.reduce((sum, w, k) => sum + w * prices[k], 0) / total : prices[0]
    trend = prices.length >= 2 ? reference.trend * (prices[0] - prices[1]) : 0
  }
  return round1(Math.max(minPrice, level + trend))
}

/**
 * The highest price an agent is willing to quote.
 *
 * Shipped behaviour is `penaltyRate` — the "never pay more than the fine" rule every
 * archetype has always followed. That rule does not actually hold in this game: paying the
 * fine does NOT discharge the obligation (see `settleYear`), the uncovered tonne is carried
 * forward as make-good debt and settled later, so defaulting costs the fine PLUS that later
 * settlement. The engine imposes no cap precisely because of this; the cap lives only in
 * agent code, which is why a genuinely uncoverable shortage pins just under the fine instead
 * of pricing through it.
 *
 * `bots.fixes.ceilingIncludesCarry` prices the carry: `penaltyRate + referencePrice`, a
 * one-period approximation of what settling the same tonne later costs.
 */
export function priceCeiling(session: Session): number {
  const P = session.state.config.market.penaltyRate
  if (!session.state.config.bots.fixes.ceilingIncludesCarry) return P
  return round1(P + referencePrice(session))
}

/**
 * Decide once a year whether to buy more abatement capacity, and buy it if so.
 *
 * Every archetype that emits goes through here so that they cannot drift apart on the one
 * decision in this game that spans years. The sizing and payback rule live in
 * `planInstall`; what this adds is the once-a-year gate, because a bot ticks a dozen times
 * a trade window and each install step pays the retrofit fee again.
 *
 * `bias` shifts the price the bot believes in, the same personality dispersion its quotes
 * carry. Returns whether anything was installed — informational; callers proceed either
 * way, since a firm that declines to invest still has to cover its emissions.
 */
export function considerInstall(
  session: Session,
  botId: string,
  rt: BotRuntime,
  price: number,
  bias = 1,
): boolean {
  const record = session.currentYearRecord()
  const player = session.getPlayer(botId)
  if (!record || !player) return false
  if (rt.lastInvestYear === record.year) return false
  rt.lastInvestYear = record.year
  const cfg = session.state.config.abatement
  const plan = planInstall({
    spec: cfg.sectors[player.industry],
    price: Math.max(0, price * bias),
    unabated: session.unabatedFor(player, record.year),
    committed: player.abatementCommitted,
    // This round's ceiling, so the bot prices the step it can actually take. Planning
    // against the lifetime cap made it size — and pay a retrofit fee for — a jump
    // `setAbatement` would then silently clamp.
    lifetimeCap: session.roundAbatementCeiling(botId, record.year),
    fixedCost: session.abatementFixedCost(botId),
    horizon: cfg.investmentHorizon,
    // A discount the agents cannot see would move half the class's abatement and none of
    // the market's, and the price the class then trades at would answer no question. Reads
    // the COMPOSED factor, so a covert discount reaches them too — a rate cut the bots
    // ignored would be a rate cut only the humans responded to.
    costFactor: session.installCostFactor(record.year),
  })
  if (!plan.install) return false
  try {
    session.setAbatement(botId, plan.target)
    return true
  } catch (e) {
    if (!(e instanceof GameError)) throw e
    return false
  }
}

/** Apply a bot's personality bias to a price and clamp it into (0.1, ceiling]. */
export function disperse(price: number, bias: number, penaltyRate: number, minPrice = 0.1): number {
  return round1(clamp(price * (1 + bias), minPrice, penaltyRate))
}

/**
 * Perceived value / mid the bots price around. Falls back to `ref` (the previous
 * round's discovered price) when the book is still empty, so a fresh year's quotes
 * start near last year's price instead of collapsing to P/2.
 */
export function marketMid(mv: MarketView, ref: number): number {
  return mv.lastPrice ?? mv.vwap ?? ref
}

/** Perceived fair value for a market view (VWAP-anchored), falling back to `ref`. */
export function anchorValue(mv: MarketView, ref: number): number {
  return mv.vwap ?? mv.lastPrice ?? ref
}

/**
 * The price the market maker quotes around: the mean of the last `n` executed trades.
 *
 * A short moving average of actual prints, not `vwap` (which weights the whole year) and not
 * `lastPrice` (which is one possibly-outlier trade). Before anything has traded this year it
 * falls back to the previous year's discovered price, so the first tick of a trade window
 * still has a sensible centre.
 */
export function recentPrice(session: Session, record: YearRecord, n: number): number {
  return meanOfLast(record.trades, n) ?? referencePrice(session)
}

/** Credits a bot can still offer without shorting (held minus its open asks). */
export function sellCapacity(session: Session, record: YearRecord, botId: string): number {
  return round1(session.creditsHeld(botId) - openSellRemaining(record.orders, botId))
}

export function ownOpenOrders(record: YearRecord, botId: string) {
  return record.orders.filter((o) => o.playerId === botId && o.status === 'open')
}

/** A bot's open orders on one side of the book. */
export function ownOpenOrdersOn(record: YearRecord, botId: string, side: OrderSide) {
  return record.orders.filter(
    (o) => o.playerId === botId && o.side === side && o.status === 'open',
  )
}

/**
 * Bring the bot's own resting quote on one side in line with what it now wants.
 *
 * Returns false — and leaves the book completely untouched — when that quote is already
 * resting at the right price with enough size, which is the common case in a quiet market.
 * Bots used to cancel and re-place their whole stack every tick, so `acted` was permanently
 * true (a full broadcast to every socket, 24×/min) and `record.orders` grew without bound
 * even when the book had not changed at all.
 *
 * It tracks the quote by ID rather than by price, so it never disturbs the bot's OTHER
 * resting orders — notably the unfilled remainder of a marketable order, which is real
 * depth the maker is providing.
 */
export function syncQuote(
  session: Session,
  record: YearRecord,
  botId: string,
  rt: BotRuntime,
  side: OrderSide,
  qty: number,
  price: number,
): boolean {
  const q = round1(Math.min(qty, session.state.config.bots.maxStep))
  const p = round1(price)
  if (!(q > 0) || !(p > 0)) return false

  const prevId = rt.quoteId?.[side]
  const prev = prevId
    ? record.orders.find((o) => o.id === prevId && o.status === 'open')
    : undefined

  // Same price, enough size still resting — leave it exactly where it is.
  if (prev && prev.price === p && prev.remaining >= q) return false

  let changed = false
  if (prev) {
    try {
      session.cancelOrder(botId, prev.id)
      changed = true
    } catch (e) {
      if (!(e instanceof GameError)) throw e
    }
  }
  if (!tryPlace(session, botId, side, q, p)) {
    if (changed) rt.quoteId = { ...rt.quoteId, [side]: undefined }
    // A cancel with no replacement still changed the book.
    return changed
  }
  // Remember what we just placed. A marketable quote can fill outright, in which case
  // nothing is left resting and the next tick simply places a fresh one.
  let newest: Order | undefined
  for (const o of record.orders) {
    if (o.playerId !== botId || o.side !== side || o.status !== 'open') continue
    if (!newest || o.seq > newest.seq) newest = o
  }
  rt.quoteId = { ...rt.quoteId, [side]: newest?.id }
  return true
}

/** Cancel all of a bot's resting orders (for requoting). Returns whether any were cancelled. */
export function cancelAllOrders(session: Session, record: YearRecord, botId: string): boolean {
  let did = false
  for (const o of ownOpenOrders(record, botId)) {
    try {
      session.cancelOrder(botId, o.id)
      did = true
    } catch (e) {
      if (!(e instanceof GameError)) throw e
    }
  }
  return did
}

/**
 * Realized average acquisition cost of a bot's current inventory: auction spend +
 * market buys over gross bought quantity. Null if it has acquired nothing.
 */
export function botAvgCost(record: YearRecord, botId: string): number | null {
  const { buyCash } = tradedCash(record.trades, botId)
  const grossBought = record.trades
    .filter((t) => t.buyerId === botId)
    .reduce((s, t) => s + t.qty, 0)
  const auctionQty = record.regulatorGranted[botId] ?? 0
  const auctionCost = auctionQty * (record.auctionPrice ?? 0)
  const totQty = auctionQty + grossBought
  if (totQty <= 0) return null
  return (auctionCost + buyCash) / totQty
}

/** Place a limit order, clamping qty to a step and swallowing GameError (skips the tick). */
export function tryPlace(
  session: Session,
  botId: string,
  side: OrderSide,
  qty: number,
  price: number,
): boolean {
  const q = round1(Math.min(qty, session.state.config.bots.maxStep))
  const p = round1(price)
  if (!(q > 0) || !(p > 0)) return false
  try {
    session.placeOrder(botId, side, q, p)
    return true
  } catch (e) {
    if (!(e instanceof GameError)) throw e
    return false
  }
}

/** Sell wrapper that clamps to the no-shorting capacity first. */
export function trySell(
  session: Session,
  record: YearRecord,
  botId: string,
  qty: number,
  price: number,
): boolean {
  const cap = sellCapacity(session, record, botId)
  return tryPlace(session, botId, 'sell', Math.min(qty, cap), price)
}

/**
 * Submit/overwrite a bot's auction bid as a sweep around `price` (`bots.sweep`): steps one σ
 * apart, centred on the price, with the total quantity shared out by `sweepWeights`
 * (normal-shaped by default — see ./sweepShape.ts). Steps that land on the same price merge;
 * steps whose share rounds to nothing are dropped. One step, no spread, or a quantity too small
 * to split is the old single bid.
 *
 * Every step stays inside `range` — the prices this bot could have bid with a single bid. The
 * sweep changes how the quantity is spread, never the bot's price limits: measured, letting a
 * compliance bot's upper steps past its ±15% band (to ~1.3 × the reference) fed each auction's
 * price into the next round's reference and walked the market to twice the fine by round 7.
 */
export function trySubmitSweep(
  session: Session,
  bot: Player,
  qty: number,
  price: number,
  range: [number, number] = [session.state.config.bots.minPrice, priceCeiling(session)],
): boolean {
  const { sweep } = session.state.config.bots
  const spread = bot.botType ? (sweep.spread[bot.botType] ?? 0) : 0
  const skew = bot.botType ? (sweep.skew[bot.botType] ?? 0) : 0
  const n = sweep.steps
  if (n <= 1 || spread <= 0 || !(round1(qty) > 0)) return trySubmitBid(session, bot.id, qty, price)
  const [lo, hi] = range
  const at = (k: number) => round1(Math.min(hi, Math.max(lo, price * (1 + k * spread))))
  const placement = bot.botType ? sweep.placement[bot.botType] : 'centred'
  let steps: { qty: number; price: number }[]
  if (placement === 'coverFirst') {
    // The old bid whole on top; the banking extra on the steps below, thinning out downward.
    const extra = qty * (bot.botType ? (sweep.bank[bot.botType] ?? 0) : 0)
    steps = [{ qty: round1(qty), price: at(0) }, ...bankWeights(n).map((w, i) => ({ qty: round1(extra * w), price: at(-(i + 1)) }))]
  } else {
    const weights = sweepWeights(n, sweep.shape, skew)
    steps = weights.map((w, i) => ({ qty: round1(qty * w), price: at(i - (n - 1) / 2) }))
    // Rounding never changes the total: the difference sits on the step with the largest share.
    const biggest = weights.indexOf(Math.max(...weights))
    steps[biggest].qty = round1(qty - steps.reduce((a, s, i) => (i === biggest ? a : a + s.qty), 0))
  }
  const live = steps.filter((s) => s.qty > 0 && s.price > 0)
  if (live.length === 0) return trySubmitBid(session, bot.id, qty, price)
  try {
    session.submitSweep(bot.id, live)
    return true
  } catch (e) {
    if (!(e instanceof GameError)) throw e
    return false
  }
}

/** Submit/overwrite an auction bid, swallowing GameError. */
export function trySubmitBid(session: Session, botId: string, qty: number, price: number): boolean {
  if (!(round1(qty) > 0) || !(round1(price) > 0)) return false
  try {
    session.submitBid(botId, round1(qty), round1(price))
    return true
  } catch (e) {
    if (!(e instanceof GameError)) throw e
    return false
  }
}

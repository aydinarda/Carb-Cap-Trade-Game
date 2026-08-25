import { buildMarketView, expectedEmission, optimalAbatement, round1 } from '../shared/engine'
import type { Session } from '../server/session'
import type { MarketView, YearRecord } from '../shared/types'

/** Sampled once per simulated tick while the market is open. */
export interface BookSample {
  spread: number | null
  depthBid: number
  depthAsk: number
  oneSided: boolean
  mid: number | null
}

export function sampleBook(mv: MarketView): BookSample {
  const bestBid = mv.bestBid
  const bestAsk = mv.bestAsk
  const depthBid = mv.bids.filter((o) => o.price === bestBid).reduce((s, o) => s + o.remaining, 0)
  const depthAsk = mv.asks.filter((o) => o.price === bestAsk).reduce((s, o) => s + o.remaining, 0)
  return {
    spread: bestBid !== null && bestAsk !== null ? round1(bestAsk - bestBid) : null,
    depthBid,
    depthAsk,
    oneSided: bestBid === null || bestAsk === null,
    mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

function supplyOf(record: YearRecord): number {
  // Reserve credits count once SOLD — otherwise this yardstick reports scarcity the
  // reserve has already relieved, and every reserve run reads as a permanent price bias.
  return (
    Object.values(record.freeAllocation).reduce((a, b) => a + b, 0) +
    record.regulatorPool +
    record.reserveReleased
  )
}

/**
 * SHORT-RUN efficient price: what clears the market *this* year, when abatement capacity
 * cannot be changed until next year.
 *
 * With the one-year lag, within-year demand is **perfectly inelastic** — every company's
 * emissions are already fixed, and no price makes them lower today. So the honest answer is
 * a corner: 0 if the class is long, the fine if it is short. There is no interior price.
 *
 * That degeneracy is a finding, not a bug in this function, and it is why it is reported
 * alongside the long-run number rather than instead of it: an inelastic market has no
 * fundamental anchor of its own, and the price it discovers comes from expectations about
 * next year. Comparing the two is what shows how much anchor the lag cost.
 */
export function efficientPriceSR(session: Session, record: YearRecord): number {
  const P = session.state.config.market.penaltyRate
  const demand = session.state.players.reduce((s, p) => s + session.plannedFor(p, record.year), 0)
  return demand > supplyOf(record) ? P : 0
}

/**
 * LONG-RUN efficient price: what would clear the class's shortage if it could install the
 * capacity it wanted, against its own MAC curves — the price a frictionless market with
 * foresight would find, and the price that *should* be driving this year's investment.
 *
 * Measured against un-abated emissions and searched over the headroom still available under
 * the lifetime cap, since capacity already installed is not a decision any more.
 *
 * ANALYSIS ONLY. This is deliberately never surfaced in the game: the in-game signal is
 * the previous year's discovered price plus the penalty ceiling. Here it is the yardstick
 * that says whether the market found the right answer.
 */
export function efficientPriceLR(session: Session, record: YearRecord): number | null {
  const cfg = session.state.config
  const P = cfg.market.penaltyRate
  const players = session.state.players
  const supply = supplyOf(record)
  const demandAt = (price: number) =>
    players.reduce((sum, p) => {
      const spec = cfg.abatement.sectors[p.industry]
      const unabated = session.unabatedFor(p, record.year)
      // Only headroom is choosable: a company at 30% cannot un-install to reach 20%.
      const r = Math.max(
        p.abatementInForce,
        optimalAbatement(spec, price, cfg.abatement.lifetimeCap),
      )
      return sum + unabated * (1 - r)
    }, 0)

  if (demandAt(0) <= supply) return 0 // no scarcity at any price
  if (demandAt(P) > supply) return P // even at the ceiling the class cannot cover — P binds

  let lo = 0
  let hi = P
  for (let i = 0; i < 60 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2
    if (demandAt(mid) > supply) lo = mid
    else hi = mid
  }
  return round1((lo + hi) / 2)
}

/** The long-run answer, under the name every existing panel and query already uses. */
export const efficientPrice = efficientPriceLR

export interface YearMetrics {
  // price behaviour
  vwap: number | null
  lastPrice: number | null
  priceMin: number | null
  priceMax: number | null
  priceStdev: number
  ceilingFrac: number
  /** Alias of `efficientPriceLR` — the long-run yardstick every existing panel plots. */
  efficientPrice: number | null
  priceVsEfficient: number | null
  /** The within-year answer under perfectly inelastic demand: 0 or the fine, never between.
   *  Reported so the lost within-year MAC anchor is visible rather than assumed away. */
  efficientPriceSR: number
  efficientPriceLR: number | null
  // depth / liquidity
  spreadMean: number | null
  depthMean: number
  oneSidedFrac: number
  orderToTrade: number
  fillRate: number
  priceImpact: number | null
  botVolumeShare: number
  unfilledDemand: number
  // primary market — all four exist on YearRecord but were never recorded
  /** Uniform clearing price of the sealed-bid auction; null under the free-allocation modes. */
  auctionPrice: number | null
  /** Credits actually sold at the cap stage. Under the free-allocation modes this is the
   *  trader-bot opening book, not a class auction. */
  auctionAwarded: number
  /** Total quantity bid into the auction. Against `regulatorPool` this is the bid-to-cover
   *  ratio — the number that shows whether a few bidders are taking the whole pool. */
  auctionBidQty: number
  /** Everything issued this year, free or sold. Mirrors Session.circulatingCap(). */
  issuance: number
  /** (need − issuance) / need. The organising variable: it makes the three cap regimes
   *  comparable on one axis, which their own knobs do not. */
  shortageRatio: number
  /** Cost containment reserve: the year's pot, what it sold, and what it collected.
   *  0/0/0 when the reserve is disabled or the year opened with no shortfall. */
  reservePot: number
  reserveReleased: number
  reserveRevenue: number
  // outcomes
  volume: number
  tradeCount: number
  freeAllocation: number
  regulatorPool: number
  totalExpected: number
  totalRealized: number
  /** Tonnes saved against the no-abatement counterfactual. */
  totalAbated: number
  /** Capacity in force, and capacity paid for but not yet online — mean fraction, and how
   *  many companies installed anything this year. The investment path, per year. */
  abatementInForceMean: number
  abatementCommittedMean: number
  abatementSpend: number
  installCount: number
  totalPenalty: number
  classCost: number
  optimalCost: number
}

export function yearMetrics(
  session: Session,
  record: YearRecord,
  samples: BookSample[],
): YearMetrics {
  const cfg = session.state.config
  const P = cfg.market.penaltyRate
  const mv = buildMarketView(record.orders, record.trades)
  const prices = record.trades.map((t) => t.price)
  const volume = round1(record.trades.reduce((s, t) => s + t.qty, 0))

  const botIds = new Set(session.state.players.filter((p) => p.isBot).map((p) => p.id))
  const botVolume = record.trades
    .filter((t) => botIds.has(t.buyerId) || botIds.has(t.sellerId))
    .reduce((s, t) => s + t.qty, 0)

  const submittedQty = record.orders.reduce((s, o) => s + o.qty, 0)
  const filledQty = record.orders.reduce((s, o) => s + (o.qty - o.remaining), 0)
  const openBuyQty = record.orders
    .filter((o) => o.side === 'buy' && o.status === 'open')
    .reduce((s, o) => s + o.remaining, 0)

  // Mean absolute mid move per 10 credits traded — how much a normal-sized order shifts
  // the price. The headline number for "is the book too thin?".
  const mids = samples.map((s) => s.mid).filter((m): m is number => m !== null)
  let impact: number | null = null
  if (mids.length > 1 && volume > 0) {
    const moves = mids.slice(1).map((m, i) => Math.abs(m - mids[i]))
    impact = round1((mean(moves) / (volume / Math.max(1, mids.length - 1))) * 10)
  }

  const efficient = efficientPriceLR(session, record)
  const discovered = mv.vwap ?? mv.lastPrice

  const settlement = record.settlement ?? {}
  const players = session.state.players
  // What the class must actually cover — capacity already in force has taken its cut.
  const totalExpected = players.reduce((s, p) => s + session.plannedFor(p, record.year), 0)
  // Tonnes saved against the counterfactual. The old form multiplied the fraction by an
  // expectation that ALREADY had the cut in it, which double-counted every standing level.
  const totalAbated = players.reduce(
    (s, p) => s + session.unabatedFor(p, record.year) * p.abatementInForce,
    0,
  )
  const spreads = samples.map((s) => s.spread).filter((x): x is number => x !== null)

  const freeAllocation = round1(Object.values(record.freeAllocation).reduce((a, b) => a + b, 0))
  const issuance = round1(freeAllocation + record.regulatorPool + record.reserveReleased)
  const expectedTotal = round1(totalExpected)

  return {
    vwap: mv.vwap,
    lastPrice: mv.lastPrice,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    priceStdev: round1(stdev(prices)),
    ceilingFrac: prices.length ? prices.filter((p) => p >= 0.98 * P).length / prices.length : 0,
    efficientPrice: efficient,
    priceVsEfficient:
      discovered !== null && efficient !== null ? round1(discovered - efficient) : null,
    efficientPriceSR: efficientPriceSR(session, record),
    efficientPriceLR: efficient,
    spreadMean: spreads.length ? round1(mean(spreads)) : null,
    depthMean: round1(mean(samples.map((s) => (s.depthBid + s.depthAsk) / 2))),
    oneSidedFrac: samples.length ? samples.filter((s) => s.oneSided).length / samples.length : 0,
    orderToTrade: record.trades.length ? record.orders.length / record.trades.length : 0,
    fillRate: submittedQty > 0 ? filledQty / submittedQty : 0,
    priceImpact: impact,
    botVolumeShare: volume > 0 ? botVolume / volume : 0,
    unfilledDemand: round1(openBuyQty),
    auctionPrice: record.auctionPrice ?? null,
    auctionAwarded: round1(Object.values(record.regulatorGranted).reduce((a, b) => a + b, 0)),
    auctionBidQty: round1(Object.values(record.auctionBid).reduce((s, b) => s + b.qty, 0)),
    issuance,
    reservePot: record.reservePot,
    reserveReleased: record.reserveReleased,
    reserveRevenue: record.reserveRevenue,
    // Guarded: sim.spec.ts asserts every numeric metric is finite, and a class with no
    // expected emissions at all would otherwise divide by zero.
    shortageRatio: expectedTotal > 0 ? round1((expectedTotal - issuance) / expectedTotal) : 0,
    volume,
    tradeCount: record.trades.length,
    freeAllocation,
    regulatorPool: record.regulatorPool,
    totalExpected: expectedTotal,
    totalRealized: round1(Object.values(record.realized).reduce((a, b) => a + b, 0)),
    totalAbated: round1(totalAbated),
    abatementInForceMean: players.length
      ? round1(players.reduce((s, p) => s + p.abatementInForce, 0) / players.length * 1000) / 1000
      : 0,
    abatementCommittedMean: players.length
      ? round1(players.reduce((s, p) => s + p.abatementCommitted, 0) / players.length * 1000) / 1000
      : 0,
    abatementSpend: round1(Object.values(record.abatementSpend).reduce((a, b) => a + b, 0)),
    installCount: Object.keys(record.abatementInstalled).length,
    totalPenalty: round1(Object.values(settlement).reduce((s, x) => s + x.penaltyCost, 0)),
    classCost: round1(Object.values(settlement).reduce((s, x) => s + x.yearCost, 0)),
    optimalCost: round1(session.state.players.reduce((s, p) => s + p.optimalScore, 0)),
  }
}

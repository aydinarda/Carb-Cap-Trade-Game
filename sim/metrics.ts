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

/**
 * The carbon price that would clear the class's aggregate shortage against its own MAC
 * curves — the price a frictionless market would find.
 *
 * ANALYSIS ONLY. This is deliberately never surfaced in the game: the in-game signal is
 * the previous year's discovered price plus the penalty ceiling. Here it is the yardstick
 * that says whether the market found the right answer.
 */
export function efficientPrice(session: Session, record: YearRecord): number | null {
  const cfg = session.state.config
  const P = cfg.market.penaltyRate
  const players = session.state.players
  const supply = Object.values(record.freeAllocation).reduce((a, b) => a + b, 0) + record.regulatorPool
  const demandAt = (price: number) =>
    players.reduce((sum, p) => {
      const spec = cfg.abatement.sectors[p.industry]
      const r = optimalAbatement(spec, price, cfg.abatement.maxFraction)
      return sum + expectedEmission(p, record.year) * (1 - r)
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

export interface YearMetrics {
  // price behaviour
  vwap: number | null
  lastPrice: number | null
  priceMin: number | null
  priceMax: number | null
  priceStdev: number
  ceilingFrac: number
  efficientPrice: number | null
  priceVsEfficient: number | null
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
  // outcomes
  volume: number
  tradeCount: number
  freeAllocation: number
  regulatorPool: number
  totalExpected: number
  totalRealized: number
  totalAbated: number
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

  const efficient = efficientPrice(session, record)
  const discovered = mv.vwap ?? mv.lastPrice

  const settlement = record.settlement ?? {}
  const totalExpected = session.state.players.reduce(
    (s, p) => s + expectedEmission(p, record.year),
    0,
  )
  const totalAbated = session.state.players.reduce(
    (s, p) => s + expectedEmission(p, record.year) * (record.abatement[p.id] ?? 0),
    0,
  )
  const spreads = samples.map((s) => s.spread).filter((x): x is number => x !== null)

  const freeAllocation = round1(Object.values(record.freeAllocation).reduce((a, b) => a + b, 0))
  const issuance = round1(freeAllocation + record.regulatorPool)
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
    totalPenalty: round1(Object.values(settlement).reduce((s, x) => s + x.penaltyCost, 0)),
    classCost: round1(Object.values(settlement).reduce((s, x) => s + x.yearCost, 0)),
    optimalCost: round1(session.state.players.reduce((s, p) => s + p.optimalScore, 0)),
  }
}

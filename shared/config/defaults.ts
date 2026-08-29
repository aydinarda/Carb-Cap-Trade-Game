import {
  BENCHMARK_STRINGENCY,
  DEFAULT_ABATEMENT,
  DEFAULT_BENCHMARK,
  INDUSTRIES,
  INDUSTRY_NAMES,
  type Industry,
} from '../constants'
import type { AbatementSpec } from '../engine/abatementModels'
import type { GameConfig } from './schema'

/**
 * The shipped configuration. Every value here reproduces exactly what the engine did
 * before the config refactor — the golden characterization test in
 * `server/__tests__/golden.spec.ts` is what proves it.
 *
 * Derived from the tables in `shared/constants.ts` wherever possible so the two can
 * never drift apart.
 */
export const DEFAULT_GAME_CONFIG: GameConfig = {
  session: {
    maxPlayers: 0, // no limit — see SessionLimits.maxPlayers
    maxNameLength: 40,
    endedGraceMs: 30 * 60_000, // 30 min
    idleTtlMs: 2 * 60 * 60_000, // 2 h
  },
  market: {
    penaltyRate: 100,
    /**
     * Year one opens at 0.25 × the fine — €25 — instead of half of it.
     *
     * With the agents' quote clamp in place this is the single strongest lever on where the
     * market STARTS: measured on a loose book, 0.20 opens at €15, 0.30 at €22, 0.40 at €28,
     * 0.50 at €35. Supply level and the LRF then decide where it ENDS. Half the fine put the
     * class in the target band on day one, which left the cap with nothing to teach.
     *
     * The calibrated auctioning setting is 0.15, not 0.25 — auctioning opens dearer than the
     * free-allocation modes at the same anchor because the primary auction prices before the
     * market does. One default cannot be both; this one matches grandfathering and
     * benchmarking, and the host panel's "Opening price anchor" field is where an auctioning
     * session moves it down.
     */
    openingReferenceFraction: 0.25,
    finalPriceFallbackFraction: 1,
    // The last ten prints of the previous year — where the market closed, not its yearly mean.
    referenceTrades: 10,
  },
  emissions: {
    industries: Object.fromEntries(
      INDUSTRY_NAMES.map((i) => [i, { ...INDUSTRIES[i] }]),
    ) as Record<Industry, { low: number; high: number }>,
    historyYears: 10,
    historyWindow: 10,
    baselineYear: 10,
    firstGameYear: 11,
    volatility: 0.08,
    generation: {
      declineLow: 0.05,
      declineHigh: 0.2,
      trendNoise: 0.03,
    },
    traderHistoryLevel: 0.1,
  },
  allocation: {
    // Grandfathering opens at the class's full baseline rather than 80% of it. The scarcity
    // now comes from the reduction factor below, which — unlike before — applies here too.
    freeCreditRatio: 1.0,
    benchmark: { ...DEFAULT_BENCHMARK },
    benchmarkStringency: BENCHMARK_STRINGENCY,
    // Just short of the class's need, which is what makes the auction a real auction: at a
    // ratio of 1.0 the pool is never fully subscribed, so it clears at the marginal BID and
    // the price it prints says nothing about scarcity. Measured bid-to-cover goes from 1.01
    // at 1.0 to 2.68 here.
    auctionCapRatio: 0.95,
    /**
     * −5%/yr.
     *
     * Softened twice: 0.84 held a clean path over ten years but compounded to under a tenth
     * of the opening supply by year fourteen, and 0.90 still ran the price past €200 in a
     * fourteen-year game. At 0.95 supply is still falling faster than the EU ETS tightens
     * (−2.2%/yr in phase 4, −4.3%/yr from 2024), which is the point — demand here falls on
     * its own as permanent capacity accumulates, so a flat cap would leave the class long.
     */
    capReductionFactor: 0.95,
    /**
     * Tightens 5%/yr while the class is still long, then eases to nothing by round twenty.
     *
     * The early rounds have to build the scarcity the game is about; the late ones have to
     * stop, or a fourteen-round game ends at €200 and a twenty-round game has no market left.
     * Flat from round 20 means the cap stops falling entirely — by then the class has spent
     * its abatement budget and the price should settle, not keep climbing.
     */
    capReductionSchedule: [
      { fromRound: 1, factor: 0.95 },
      { fromRound: 10, factor: 0.965 },
      { fromRound: 13, factor: 0.98 },
      { fromRound: 17, factor: 0.99 },
      { fromRound: 20, factor: 1 },
    ],
    /**
     * ON, which reverses the shipped asymmetry.
     *
     * Grandfathering used to be exempt, so its supply never tightened and the reduction
     * factor above did nothing at all in that mode. That was survivable when free credits
     * started at 80% of baseline and the class was short from year one. It is not survivable
     * now that they start at 100%: with the factor exempt, grandfathering would open with no
     * scarcity and never acquire any. The calibrated grandfathering candidate was measured
     * with this on, and is invalid without it.
     */
    applyLRFToGrandfathering: true,
    reserve: {
      enabled: true,
      basis: 'shortfall',
      triggerTrades: 5, // matches bots.marketMaker.recentTrades
      /**
       * Absolute euros, not fractions of penaltyRate: these are meaningful against the MAC
       * curves (every sector hits the 20% abatement cap between 25 and 70), not against the
       * fine.
       *
       * A rung's price effect comes from WHERE IT SITS, not from how much it sells: it is the
       * cheapest ask in the book while it rests, so it caps every print regardless of size.
       * Measured on an earlier ladder, halving the pot moved the price €2 while raising a rung
       * €10 moved it €6.
       *
       * The rungs used to start at €70 and run to €95 in four steps, sized for a €60-70 target
       * band. With prices now reaching three figures that ladder was spent late and did almost
       * nothing: under 5% of issuance, and 0% for the first five to seven rounds. Two rungs
       * that ratchet to 20% by €70, then `recurring` below, replaces it.
       */
      steps: [
        { triggerPrice: 65, cumulativeFraction: 0.1 },
        { triggerPrice: 70, cumulativeFraction: 0.2 },
      ],
      /**
       * From €78 on, 5% of the pot is offered again at €78 and again at €85 EVERY round.
       *
       * The ladder alone is spent once and then silent, which left the reserve supplying
       * under 5% of issuance and nothing at all in the rounds before the price reached its
       * first rung. A market that keeps climbing needs relief that keeps arriving.
       */
      recurring: {
        fromPrice: 78,
        offers: [
          { price: 78, fraction: 0.05 },
          { price: 85, fraction: 0.05 },
        ],
      },
    },
  },
  abatement: {
    // The game has always used the linear MAC; the other models exist for scenarios.
    sectors: Object.fromEntries(
      INDUSTRY_NAMES.map((i) => [
        i,
        { model: 'linear', params: { ...DEFAULT_ABATEMENT[i] } } satisfies AbatementSpec,
      ]),
    ) as Record<Industry, AbatementSpec>,
    // A plant cannot switch itself off: 50% of its un-abated emissions is the most a company
    // can ever cut, across the whole game. Applies to every cap mechanism.
    lifetimeCap: 0.5,
    // 4–10% of what a full lifetime install costs per tonne of baseline (14.4–38.8 by
    // sector), so a second step costs a few percent more rather than a fortune — but it
    // still exceeds the variable cost of a *small* step (a 10% Power cut is 1.375/t),
    // which is exactly the nibbling it exists to discourage.
    fixedCostPerTonneBaseline: 1.5,
    // Agents only. Long enough that a genuine retrofit pays back, short enough that they
    // will not buy capacity on a single year's price spike.
    investmentHorizon: 3,
  },
  bots: {
    // `underAuction` ships OFF: it changes who holds the opening book under auctioning, and
    // that is a calibration decision, not a default. Turn it on to measure it.
    seed: { marketMakerFrac: 0.18, speculatorFlat: 20, underAuction: false },
    maxStep: 40,
    minPrice: 0.5,
    sigma: { compliance: 0.05, marketMaker: 0.08, speculator: 0.12, noise: 0.2 },
    marketMaker: {
      minMargin: 2.5,
      spreadFrac: 0.06,
      skew: 0.04,
      skewCapFrac: 0.4,
      invFrac: 0.18,
      quoteSize: 15,
      bandFrac: 0.05,
      recentTrades: 5,
      // A quarter of the simulator's 12-tick window. The maker is silent while the class
      // opens the year, then quotes for the rest of it.
      quietTicks: 3,
      auctionPremium: 0.05,
    },
    speculator: { size: 10, initialInventory: 20, momentumEps: 0.01 },
    noise: {
      size: 4,
      errorRate: 0.25,
      skipRate: 0.2,
      priceJitter: 0.25,
      auctionJitter: 0.1,
      sizeJitter: 0.5,
    },
    // minTradeSize is TONNES and does not scale with money; priceStep is money.
    compliance: { minTradeSize: 0.5, priceStep: 0.5, coverTarget: 1.1 },
    fixes: {
      noiseAbatement: false,
      complianceReservation: false,
      // ON by default. Without these the makers re-buy their whole target inventory at every
      // auction and each one sizes it off the entire pool, so four of them took 72% of the
      // cap every year and sat on it — 154k credits by year 20, seven times one year's
      // issuance, while emitters bid the price to the ceiling for want of a seller.
      // OFF: it stopped the maker bidding at all once its target was met, which left the
      // offer side of the book to drain. The hoarding it guarded against is now bounded by
      // marketMakerShareByCount instead.
      marketMakerIncrementalBid: false,
      marketMakerShareByCount: true,
      // ON. The fine is NOT a ceiling and the engine never treated it as one: an uncovered
      // tonne is fined AND still carried as make-good debt (see `settleYear`), so the true
      // cost of defaulting is the fine PLUS buying that tonne later. Clamping every agent at
      // `penaltyRate` imposed a ceiling the economics does not justify, and it was the only
      // thing keeping a genuinely uncoverable shortage from pricing above the fine.
      //
      // Measured cost of turning it on: the price runs above 100 in the late years of a tight
      // run (peak ~120 in the phase-anchor sweep), so a target band whose top sits at the
      // fine can no longer be held by the clamp. That is the point — the band now has to be
      // held by supply, not by an artificial cap.
      ceilingIncludesCarry: true,
    },
  },
}

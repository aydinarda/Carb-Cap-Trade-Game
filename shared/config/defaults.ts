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
     * −16%/yr. The steepest tightening in the calibrated grid, and far steeper than any real
     * scheme: the EU ETS runs −2.2%/yr in phase 4 and −4.3%/yr from 2024.
     *
     * That gap is not a mistake, it is the consequence of permanent abatement. A class of 25
     * installs capacity within a few years and KEEPS the cut, so demand here falls roughly
     * 10%/yr on its own. Supply has to fall faster than that to stay short at all — matched
     * against Europe's pace the market simply drifts into a glut by year four.
     *
     * NOTE this sits on the edge of the swept range, so it is the best value TRIED, not a
     * proven optimum. Nothing steeper has been measured.
     */
    capReductionFactor: 0.84,
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
       * The first rung sits at the TOP of the €60-70 target band, not inside it. Measured:
       * a rung's price effect comes from where it sits, not from how much it sells — it is
       * the cheapest ask in the book, so it caps every print regardless of size (halving the
       * pot moved the price 2 €; raising the rung 10 € moved it 6 €). A rung inside the band
       * therefore suppresses the market before it ever reaches the target. Starting at 70
       * left the first six years' price path almost identical to having no reserve at all,
       * while cutting trades pinned at the fine from 6-12% to 0-1%. See §10 of
       * sim/sweeps/price-calibration.ipynb.
       */
      steps: [
        { triggerPrice: 70, cumulativeFraction: 0.08 },
        { triggerPrice: 78, cumulativeFraction: 0.13 },
        { triggerPrice: 86, cumulativeFraction: 0.19 },
        { triggerPrice: 95, cumulativeFraction: 0.25 },
      ],
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
    compliance: { minTradeSize: 0.5, priceStep: 0.5 },
    fixes: {
      noiseAbatement: false,
      complianceReservation: false,
      // ON by default. Without these the makers re-buy their whole target inventory at every
      // auction and each one sizes it off the entire pool, so four of them took 72% of the
      // cap every year and sat on it — 154k credits by year 20, seven times one year's
      // issuance, while emitters bid the price to the ceiling for want of a seller.
      marketMakerIncrementalBid: true,
      marketMakerShareByCount: true,
      ceilingIncludesCarry: false,
    },
  },
}

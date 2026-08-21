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
    openingReferenceFraction: 0.5,
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
    freeCreditRatio: 0.8,
    benchmark: { ...DEFAULT_BENCHMARK },
    benchmarkStringency: BENCHMARK_STRINGENCY,
    auctionCapRatio: 1,
    capReductionFactor: 0.97,
    applyLRFToGrandfathering: false,
  },
  abatement: {
    // The game has always used the linear MAC; the other models exist for scenarios.
    sectors: Object.fromEntries(
      INDUSTRY_NAMES.map((i) => [
        i,
        { model: 'linear', params: { ...DEFAULT_ABATEMENT[i] } } satisfies AbatementSpec,
      ]),
    ) as Record<Industry, AbatementSpec>,
  },
  bots: {
    seed: { marketMakerFrac: 0.18, speculatorFlat: 20 },
    maxStep: 40,
    minPrice: 0.5,
    sigma: { compliance: 0.05, marketMaker: 0.08, speculator: 0.12, noise: 0.2 },
    marketMaker: {
      minMargin: 2.5,
      spreadFrac: 0.06,
      skew: 0.04,
      skewCapFrac: 0.4,
      invFrac: 0.18,
      auctionAggr: 1.3,
      quoteSize: 15,
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
    // All off: the shipped game keeps the behaviour it has until a sweep says otherwise.
    fixes: {
      noiseAbatement: false,
      complianceReservation: false,
      marketMakerIncrementalBid: false,
      marketMakerShareByCount: false,
    },
  },
}

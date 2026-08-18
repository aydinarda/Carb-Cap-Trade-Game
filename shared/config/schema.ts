import type { Industry } from '../constants'
import type { AbatementSpec } from '../engine/abatementModels'
import type { BotType } from '../types'

/**
 * Every tunable number in the game, in one place.
 *
 * Before this existed the knobs were scattered across `shared/constants.ts`, module-level
 * consts in `server/bots/types.ts`, and inline literals in the engine and the bots — which
 * meant a question like "what happens if abatement is much dearer?" could not be asked
 * without editing the engine. A `Session` now takes a `DeepPartial<GameConfig>` override,
 * so a simulation scenario declares whatever it wants to vary and inherits the rest.
 *
 * This type is NOT sent over the wire — the host snapshot carries a narrow derived view
 * (`HostConfigView`) instead, because it is rebuilt and pushed to every socket on every
 * bot tick.
 */
export interface GameConfig {
  session: SessionLimits
  market: MarketConfig
  emissions: EmissionsConfig
  allocation: AllocationConfig
  abatement: AbatementConfig
  bots: BotsConfig
}

export interface SessionLimits {
  /** Session capacity. Bots and humans share it. (was `MAX_PLAYERS`) */
  maxPlayers: number
  /** Max characters in a player name. */
  maxNameLength: number
}

export interface MarketConfig {
  /** Cost per tCO2 left uncovered at settlement — the effective ceiling on the price. */
  penaltyRate: number
  /**
   * Opening reference price when nothing has traded yet, as a fraction of `penaltyRate`
   * (was the literal `penaltyRate / 2`). This is the highest-leverage number in the game
   * after the penalty itself: it seeds every bot's anchor, the trader-bot seed price, and
   * the benchmarking primary price in year one.
   */
  openingReferenceFraction: number
  /** End-of-game carry monetization fallback, as a fraction of `penaltyRate`. */
  finalPriceFallbackFraction: number
}

export interface EmissionsConfig {
  /** Per-sector range the generated history is drawn from. (was `INDUSTRIES`) */
  industries: Record<Industry, { low: number; high: number }>
  /** Length of the generated pre-game history. */
  historyYears: number
  /** Grandfathering's moving window. */
  historyWindow: number
  /** Which year counts as the baseline for Σbaseline and leaderboard normalization. */
  baselineYear: number
  /** First playable year — also the exponent origin for the cap reduction factor. */
  firstGameYear: number
  /** σ of the realization draw, as a fraction of the mean. (was `EMISSION_VOLATILITY`) */
  volatility: number
  generation: {
    /** oldest = latest × (1 + U(declineLow, declineHigh)) */
    declineLow: number
    declineHigh: number
    /** N(0, trendNoise × latest) applied to each point of the trend. */
    trendNoise: number
  }
  /** Flat per-year history level given to pure-trader bots (they barely emit). */
  traderHistoryLevel: number
}

export interface AllocationConfig {
  /** Grandfathering cap = this × Σbaseline. (was `FREE_CREDIT_RATIO`) */
  freeCreditRatio: number
  /** Benchmarking: free credits per company, by sector. Host-editable. */
  benchmark: Record<Industry, number>
  /** How far below the sector average the default benchmark sits (0.6 = 40% below). */
  benchmarkStringency: number
  /** Auction supply = this × Σbaseline. Host-editable. */
  auctionCapRatio: number
  /** Supply/benchmark shrinks by this factor each year (EU-ETS LRF); 1 = flat. */
  capReductionFactor: number
  /**
   * Whether the LRF also tightens grandfathering. Defaults to `false`, preserving the
   * shipped asymmetry where only benchmarking and auctioning tighten; simulations turn it
   * on to compare the three modes on equal footing.
   */
  applyLRFToGrandfathering: boolean
}

export interface AbatementConfig {
  /** Per-sector marginal abatement cost curve. */
  sectors: Record<Industry, AbatementSpec>
}

export interface MarketMakerConfig {
  /** Absolute floor on the half-spread, and the profit margin over average cost. */
  minMargin: number
  /** Half-spread as a fraction of perceived value. */
  spreadFrac: number
  /** Price shift per unit of inventory deviation from target. */
  skew: number
  /** Skew is clamped to ±(this × penaltyRate). */
  skewCapFrac: number
  /** Target inventory = this × the credits in circulation. */
  invFrac: number
  /** Auction bid = this × reference price, capped at the penalty. */
  auctionAggr: number
  /** Resting quote size each side. */
  quoteSize: number
}

export interface BotsConfig {
  /** Opening book sold to pure traders when the mode has no primary auction. */
  seed: {
    /** Market maker seed = this × the class's free allocation. */
    marketMakerFrac: number
    /** Speculator seed, flat. */
    speculatorFlat: number
  }
  /** Per-order quantity cap, so bots work positions gradually. */
  maxStep: number
  /** Minimum price a bot will ever quote — the effective tick floor. */
  minPrice: number
  /** Persistent personality price dispersion (σ), drawn once per bot. */
  sigma: Record<BotType, number>
  marketMaker: MarketMakerConfig
  speculator: {
    size: number
    /** Inventory bought at auction so it has something to sell. */
    initialInventory: number
    /** Price move fraction that triggers a momentum trade. */
    momentumEps: number
  }
  noise: {
    size: number
    /** Chance to flip side. */
    errorRate: number
    /** Chance to idle a tick. */
    skipRate: number
    /** ±fraction of price jitter when trading. */
    priceJitter: number
    /** ±fraction of price jitter when bidding at auction. */
    auctionJitter: number
    /** Order size is multiplied by U(1 − sizeJitter, 1 + sizeJitter). */
    sizeJitter: number
  }
  compliance: {
    /** Dead band: ignore a gap smaller than this many tonnes. */
    minTradeSize: number
    /** How far inside its reservation/fair value it rests an order. */
    priceStep: number
  }
}

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
  scoring: ScoringConfig
  bots: BotsConfig
}

/**
 * How the leaderboard turns two cost gaps into one number a student can read.
 *
 * The gaps themselves are engine output and not configurable — what lives here is the
 * editorial part: how much the investment decision counts relative to the trading one, and
 * how steeply points fall away from perfect play.
 */
export interface ScoringConfig {
  /**
   * Weight on the investment gap relative to the trading gap, which is fixed at 1.
   *
   * Both arrive in the same units (euros per tonne of baseline emission), so this is a
   * straight statement of what the game is about. Below 1 the market is the lesson and the
   * retrofit is a side quest; at 1 they are equal; above 1 a class is being told that what
   * it builds matters more than what it trades. Set 0 to score trading alone, which is what
   * every session before this one did.
   */
  investmentWeight: number
  /**
   * The combined gap, in euros per tonne of baseline, at which a player scores 100/e ≈ 37
   * points. Twice this scores ≈ 13, three times ≈ 5.
   *
   * An exponential rather than a linear scale for one reason: a linear map needs a WORST
   * case to divide by, and the worst case in this game is unbounded (a company can default
   * on everything, every year, at any price). Anchoring on the good end instead means the
   * scale never has to be re-chosen because one student had a catastrophic round, and the
   * top of the table — where the interesting differences are — keeps its resolution.
   */
  pointsScale: number
}

export interface SessionLimits {
  /**
    * Session capacity — bots and humans share it. **0 means no limit**, which is the
    * shipped default: the real ceiling is the broadcast cost, not a fixed number.
    * Set a positive value to cap a room deliberately.
    */
  maxPlayers: number
  /** Max characters in a player name. */
  maxNameLength: number
  /**
   * How long a finished room is kept after `endGame` before the store drops it — long
   * enough that everyone can still read the final leaderboard.
   */
  endedGraceMs: number
  /** How long a room with nobody connected is kept before the store drops it. */
  idleTtlMs: number
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
  /**
   * How many of the PREVIOUS year's closing prints the next year's reference price averages
   * over, volume-weighted.
   *
   * The reference seeds every bot's anchor and the auction's opening bid, so it decides where
   * a year starts. It used to be the whole previous year's VWAP, which in a volatile year is
   * an average of prices nobody was still paying by the close — a year that ran 40 → 190 → 90
   * handed the next one a number matching none of those phases.
   */
  referenceTrades: number
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

export interface ReserveStep {
  /** Market price at or above which this rung unlocks — AND the price it offers at (€/t). */
  triggerPrice: number
  /** Cumulative share of the base releasable once this rung is unlocked (0..1]. */
  cumulativeFraction: number
}

/**
 * Cost containment reserve: a finite pot of extra allowances the regulator offers into the
 * market as the price climbs, in steps. Modelled on RGGI's CCR.
 *
 * It exists because a shortage larger than the class can physically abate
 * (`abatement.lifetimeCap`) is otherwise uncoverable — the price simply pins to the fine and
 * there is nothing to buy at any price. It is a *secondary* mechanism: sized to relieve a
 * squeeze, not to set the price.
 */
export interface ReserveConfig {
  enabled: boolean
  /**
   * What the pot is a share of, recomputed at each year open.
   * `shortfall` = max(0, totalExpected − issuance); `need` = totalExpected.
   *
   * NOTE `shortfall` is ZERO under auctioning at `auctionCapRatio >= 1`, because supply is
   * issued equal to (or above) need — so the reserve is correctly inert there. Switch to
   * `need` if you want it armed in that case too.
   */
  basis: 'shortfall' | 'need'
  /** How many of this year's prints the trigger price averages over. */
  triggerTrades: number
  /**
   * The ladder, strictly increasing in both fields. The pot is the LAST rung's fraction —
   * there is deliberately no separate size knob, which could contradict the ladder.
   *
   * Strictly increasing is a requirement, not a style note: a rung whose cumulative fraction
   * is at or below the one before it releases `ceiling − covered ≤ 0` and is silently inert.
   */
  steps: ReserveStep[]
  /**
   * A top-up that repeats EVERY round, once the price has climbed past `fromPrice`.
   *
   * The ladder above ratchets one way and then it is spent: a market that keeps climbing
   * gets nothing more from it, which is exactly when the relief is wanted. Measured on the
   * shipped ladder, the reserve supplied 0% of issuance for the first five to seven rounds
   * and never more than 5% after — it was, in practice, not a mechanism.
   *
   * This offers `fraction × base` at each listed price, once per round, for as long as the
   * price stays above `fromPrice`. Set `offers` empty to disable.
   */
  recurring: {
    fromPrice: number
    offers: { price: number; fraction: number }[]
  }
}

export interface AllocationConfig {
  /** Grandfathering cap = this × Σbaseline. (was `FREE_CREDIT_RATIO`) */
  freeCreditRatio: number
  /** Benchmarking: free credits per company, by sector. Host-editable. */
  benchmark: Record<Industry, number>
  /** The default benchmark as a multiple of the sector average (1.119 = 12% above it,
   *  which the yearly cap reduction then tightens). Dead config — `benchmarkFor` reads
   *  `benchmark`, so the TABLE is what a scenario has to move. */
  benchmarkStringency: number
  /** Auction supply = this × Σbaseline. Host-editable. */
  auctionCapRatio: number
  /**
   * Hybrid mode: the share of its sector benchmark a company is issued FREE, per sector
   * (0..1). 1 issues the whole benchmark free, 0 issues nothing — that sector buys every
   * allowance at the auction. Host-editable.
   *
   * It multiplies `benchmark`, so the yearly cap reduction tightens the free allocation
   * exactly as it tightens it under benchmarking; and the result is DEDUCTED from the
   * auction pool rather than added on top of it, so the shares redistribute a fixed cap
   * instead of loosening it. See `shared/engine/hybrid.ts`.
   */
  hybridFreeShare: Record<Industry, number>
  /**
   * Auction reserve price, as a fraction of the reference (the previous round's closing
   * price). The regulator sells nothing below it.
   *
   * 0 disables it, which is what the engine did before — and an undersubscribed auction then
   * cleared at the lowest bid on the book, tying the whole year's anchor to whichever bot
   * happened to be least eager.
   */
  auctionReserveFrac: number
  /** Supply/benchmark shrinks by this factor each year (EU-ETS LRF); 1 = flat. */
  capReductionFactor: number
  /**
   * A DECELERATING tightening schedule: the factor in force from a given round onward.
   *
   * A single factor compounds, and compounding is what broke every long game. 0.84 left
   * supply under a tenth of its opening level by round fourteen; 0.90 still ran the price
   * past €200; 0.95 stopped the explosion but only by tightening so slowly that rounds two
   * to four collapsed to €13 before scarcity caught up. There is no constant that both
   * builds scarcity early and stops building it later, because a constant cannot do two
   * things.
   *
   * A schedule can: tighten hard while the class is long, then ease off as the cap starts to
   * bite, and go flat once the market should plateau. Entries are `{ fromRound, factor }`
   * with `fromRound` 1-based from the first game year; the factor applies from that round
   * until the next entry. Empty = use `capReductionFactor` for every round.
   */
  capReductionSchedule: { fromRound: number; factor: number }[]
  /**
   * Whether the LRF also tightens grandfathering. Defaults to `false`, preserving the
   * shipped asymmetry where only benchmarking and auctioning tighten; simulations turn it
   * on to compare the three modes on equal footing.
   */
  applyLRFToGrandfathering: boolean
  /** Price-triggered supply release. Applies to every cap mechanism. */
  reserve: ReserveConfig
}

export interface AbatementConfig {
  /** Per-sector marginal abatement cost curve. */
  sectors: Record<Industry, AbatementSpec>
  /**
   * The most of its own **un-abated** emissions a company may ever cut, as a fraction, over
   * the whole game. Not per year — abatement is installed capacity, and this is the budget.
   *
   * A real installation cannot go to zero: it can retrofit, switch fuel or cut output at
   * the margin, but the plant still has to run. Without this the optimum at a high enough
   * price is a 100% cut, which is both physically impossible and pedagogically wrong — it
   * makes the carbon price look like it can solve compliance on its own.
   *
   * This binds the slider a student sees and what `Session.setAbatement` will accept.
   * Lowering it mid-game binds future installs only: nothing is un-installed or refunded.
   *
   * (Was `maxFraction`, a per-year ceiling. Renamed rather than repurposed so that any
   * scenario file written against the old meaning fails loudly instead of lying.)
   */
  lifetimeCap: number
  /**
   * Retrofit fee charged **on every install step**, multiplied by the company's
   * baseline-year emission. Paying it again for each step is what makes going in small
   * bites dearer than going once: 10% then 40% costs `2·fee + ∫₀^0.5`, where 50% in one
   * move costs `fee + ∫₀^0.5`.
   *
   * Scaled by the baseline rather than by current emissions on purpose. A flat fee would
   * be ~7× Transport's annual emission but ~2× Power's; and a fee tracking *current*
   * emissions would shrink after the first step, which would break that identity.
   */
  fixedCostPerTonneBaseline: number
  /**
   * How many years of savings an **agent** requires to cover an install before it will pay
   * the fee. Purely a bot/simulated-student parameter — the engine neither reads it nor
   * enforces any payback on a human, who is free to invest at any price.
   */
  investmentHorizon: number
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
  /** Resting quote size each side. */
  quoteSize: number
  /**
   * How far either quote may sit from the recent price, as a fraction. The maker buys within
   * `[ref × (1 − bandFrac), ref]` and sells within `[ref, ref × (1 + bandFrac)]`, so it can
   * never drag the market away from where it is actually trading — the failure the
   * inventory-skewed centre allowed, where a long maker's centre fell far below the market.
   */
  bandFrac: number
  /** How many recent trades the reference price averages over. */
  recentTrades: number
  /**
   * Trade-stage ticks the maker sits out at the start of each year, quoting nothing and
   * taking nothing.
   *
   * It exists so the class sets the opening price. A maker that quotes from tick one anchors
   * the year on last year's reference before any emitter has expressed what it needs, and
   * every other bot then prices off that anchor.
   */
  quietTicks: number
  /**
   * Premium over the reference the maker bids at the auction, as a fraction.
   *
   * The maker is buying a book to sell from, so it has to outbid the emitters that only want
   * to cover themselves — bidding at or under the reference (the previous rule) left it
   * winning 18% of the pool once and nothing afterwards.
   */
  auctionPremium: number
}

export interface BotsConfig {
  /** Opening book sold to pure traders when the mode has no primary auction. */
  seed: {
    /** Market maker seed = this × the class's free allocation. */
    marketMakerFrac: number
    /** Speculator seed, flat. */
    speculatorFlat: number
    /**
     * Also seed the traders under AUCTIONING, where they otherwise start with nothing and
     * must win the whole sell side at the auction.
     *
     * Measured, they do not: a maker fills its target once in year one (18% of the pool) and
     * then bids the gap, which is zero, so it never buys again — and its inventory drains
     * from 1662 to 651 tonnes over eight years while the offer side of the book thins out.
     * Auctioning carries about a quarter of benchmarking's sellable stock for this reason.
     *
     * Sized off the auction POOL rather than the free allocation, which is zero in this mode,
     * and charged at the clearing price like every other allowance bought at the cap stage —
     * the maker pays for its book, so its P&L stays comparable to a student's.
     */
    underAuction: boolean
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
    /**
     * How much cover the firm buys, as a multiple of what it must surrender. 1.1 = a 10%
     * buffer.
     *
     * Above 1 for a structural reason, not for realism. Under auctioning a compliance firm
     * starts every year holding nothing and bids for EXACTLY its residual, so the best
     * position it can reach is square — it is arithmetically incapable of holding a surplus,
     * and therefore of ever selling. Measured over six years: 1477 tonnes of buy orders,
     * ZERO sell orders, zero firms ever long. That leaves the entire offer side to the market
     * makers, and the book goes one-sided.
     *
     * The buffer makes an emitter a potential seller. It becomes sellable exactly when the
     * firm's need falls — it installed capacity, or its emissions drifted down — which under
     * a tightening cap is when the market most needs an offer.
     */
    coverTarget: number
    /**
     * How far an auction bid may sit from the market price, as a fraction either side.
     *
     * The auction and the order book must not drift apart. Left unbounded, a firm bidding its
     * own reservation produced a clearing price of 43 while the book traded at 120 — every
     * winner collected a 77 euro arbitrage nobody competed for. Bidding the plain market price
     * instead removed the arbitrage but made demand perfectly inelastic, so the clearing price
     * stopped responding to scarcity at all.
     *
     * A band gives both: the price is anchored to what a tonne last traded at, and a firm that
     * is short still bids the top of the band while a comfortable one bids the bottom. The
     * uniform-price auction then clears inside the band, near the market, with the position
     * still visible in where it lands.
     */
    auctionBandFrac: number
  }
  /**
   * Corrections to bot behaviour, each off by default so the shipped game is unchanged and
   * a calibration sweep can measure before and after on the same seeds. Turn one on only
   * with evidence — see sim/sweeps/price-calibration.ts.
   */
  fixes: {
    /**
     * Whether the noise bot ever invests in abatement capacity.
     *
     * It used to guard a plain bug: the bot sized its order as `expected × (1 − r*) − held`
     * but never called setAbatement, so it traded as if it had cut while its recorded
     * abatement stayed 0, and was short by `expected × r*` at every settlement. That is
     * gone — sizing reads `plannedEmission`, which cannot disagree with the engine.
     *
     * What is left is a behavioural question worth being able to answer both ways: is a
     * careless trader also a firm that never retrofits? Off means it trades badly AND never
     * decarbonises, which is a coherent archetype, not a defect.
     */
    noiseAbatement: boolean
    /**
     * `reservationPrice` returns penaltyRate outright at `rCover >= 1`, i.e. whenever the
     * firm holds nothing. Under auctioning that is the normal state, so the bot bids the
     * ceiling on the first tick. At exactly rCover === 1 the right answer is the cost of a
     * full cut, min(P, MAC(1)) = a + b.
     */
    complianceReservation: boolean
    /**
     * The market maker's auction bid is a target inventory *level* submitted as an
     * incremental *purchase* every year, with no `− held` term, so its holdings compound
     * without bound. Bid the gap to target instead.
     */
    marketMakerIncrementalBid: boolean
    /**
     * Each market maker targets `invFrac × circulatingCap()` independently, so N makers
     * chase N × 18% of the whole pool. Divide the target by the number of makers.
     */
    marketMakerShareByCount: boolean
    /**
     * Every agent clamps its own quote to `penaltyRate`, which puts an artificial ceiling on
     * the market that the engine itself does not impose — and that the economics does not
     * justify, because the fine does not discharge the obligation (see `settleYear`): an
     * uncovered tonne is fined AND carried as make-good debt. The true cost of defaulting is
     * the fine PLUS settling the same tonne later, so willingness to pay sits above the fine.
     *
     * With this on, the agents' quote ceiling becomes `penaltyRate + referencePrice` — a
     * one-period approximation of that carry. It is what lets a genuinely uncoverable
     * shortage price above the fine instead of pinning just under it.
     */
    ceilingIncludesCarry: boolean
  }
}

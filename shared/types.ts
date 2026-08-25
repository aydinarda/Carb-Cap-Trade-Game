import type { GameConfig } from './config/schema'
import type { Industry } from './constants'
import type { AbatementSpec } from './engine/abatementModels'

export type CapMode = 'grandfathering' | 'benchmarking' | 'auctioning'

/** Backend bot archetypes (auctioning mode). See server/bots/. */
export type BotType = 'compliance' | 'marketMaker' | 'speculator' | 'noise'

export type Phase =
  | 'lobby' // registration open, players joining and picking industries
  | 'cap' // players request extra credits from the regulator pool
  | 'reveal' // realized emissions shown
  | 'trade' // student order-book market is open
  | 'yearSummary' // year settled: penalties applied, results shown
  | 'ended'

export interface PlayerProfile {
  industry: Industry
  /** Absolute year -> tCO2. Years 1..10 are generated history; 11+ are realized. */
  emissions: Record<number, number>
}

export interface Player extends PlayerProfile {
  id: string // "P1", "P2", … in join order (matches the notebook)
  name: string
  connected: boolean
  /** Cumulative actual cost across years (abatement + credit spend + penalties). */
  score: number
  /** Cumulative best-achievable cost — the per-company optimum benchmark. */
  optimalScore: number
  /**
   * EU-ETS carry balance rolled between years: positive = allowances banked from a
   * surplus year; negative = a make-good debt from an uncovered year. Added to the
   * next year's holdings; monetized at the final market price when the game ends.
   */
  bankedCredits: number
  /**
   * Installed abatement capacity, as a fraction of the company's **un-abated** emissions.
   * Three numbers because the capacity is permanent and takes a year to come online:
   *
   *  - `abatementCommitted` — everything paid for. Monotonically rising, capped by
   *    `config.abatement.lifetimeCap`. Effective from NEXT year.
   *  - `abatementInForce`   — what is cutting THIS year's emissions. Only `openYear` moves
   *    it, which is precisely what makes the one-year lag impossible to bypass.
   *  - `abatementEmbedded`  — the level already baked into the last realized emission, and
   *    so the divisor that recovers the un-abated level from it.
   *
   * Invariant: 0 ≤ embedded ≤ inForce ≤ committed ≤ lifetimeCap.
   */
  abatementInForce: number
  abatementCommitted: number
  abatementEmbedded: number
  /** Backend bot (no socket). Undefined for human players. */
  isBot?: boolean
  /** Which archetype this bot plays (only set when isBot). */
  botType?: BotType
}

export type OrderSide = 'buy' | 'sell'

export interface Order {
  id: string
  playerId: string
  side: OrderSide
  qty: number
  remaining: number
  price: number
  status: 'open' | 'filled' | 'cancelled'
  seq: number // placement order, for time priority
}

export interface Trade {
  id: string
  buyerId: string
  sellerId: string
  qty: number
  price: number
  seq: number
}

/** Live order-book market view (shared by players and host). */
export interface MarketView {
  bids: Order[] // open buys, best (highest price) first
  asks: Order[] // open sells, best (lowest price) first
  trades: Trade[] // most recent first
  lastPrice: number | null
  bestBid: number | null
  bestAsk: number | null
  vwap: number | null
  volume: number
}

export interface PlayerSettlement {
  shortage: number
  /** Cost of the emission cuts the company invested in this year. */
  abatementCost: number
  /** Cap-stage cost (auction) + cash spent buying in the market. */
  purchaseCost: number
  /** Cash earned selling in the market. */
  sellIncome: number
  /** shortage × penaltyRate. */
  penaltyCost: number
  /** abatementCost + purchaseCost − sellIncome + penaltyCost. */
  yearCost: number
}

export interface YearRecord {
  year: number
  freeAllocation: Record<string, number>
  /** Credits acquired at the cap stage: auction award (auctioning) or 0 (G/B). */
  regulatorGranted: Record<string, number>
  /** Auctioning mode: the auction supply (= the cap). Unused for G/B. */
  regulatorPool: number
  /** EU-ETS carry banked (+) or owed (−) coming INTO this year, per company. */
  carriedIn: Record<string, number>
  realized: Record<string, number>
  /** Continuous order-book market: resting/filled orders and executed trades. */
  orders: Order[]
  trades: Trade[]
  /**
   * Installed capacity **in force this year** (0..1) — the cut actually applied to this
   * year's realized emissions. Populated from `Player.abatementInForce` at year open, and
   * no longer wiped: capacity is permanent, so it carries across years.
   */
  abatement: Record<string, number>
  /** Capacity newly committed during this year. Comes online next year. */
  abatementInstalled: Record<string, number>
  /** Money charged for those installs — fee(s) plus the variable cost of the new slice. */
  abatementSpend: Record<string, number>
  /** Auctioning mode: each company's sealed bid at the cap stage. */
  auctionBid: Record<string, { qty: number; price: number }>
  /** Auctioning mode: uniform clearing price after the auction closes. */
  auctionPrice: number | null
  /**
   * Unit price charged for everything in `regulatorGranted`: the auction clearing
   * price under auctioning, the opening reference price for the trader-bot seed
   * under benchmarking, 0 under grandfathering.
   */
  primaryPrice: number | null
  settlement: Record<string, PlayerSettlement> | null
  netPosition: Record<string, number>
  /**
   * Cost containment reserve. Fixed at year open; 0 means inert for this year — which is the
   * correct state whenever issuance already meets need (auctioning at auctionCapRatio >= 1).
   */
  reservePot: number
  /** Credits the reserve has actually SOLD this year. */
  reserveReleased: number
  /**
   * Sold PLUS still resting unsold. This is what the ladder measures itself against, and it
   * is tracked incrementally rather than derived: scanning open orders on every placeOrder
   * would be O(orders) per order, and `orders` reaches thousands in a full year.
   */
  reserveCommitted: number
  /** Cash the reserve collected. Belongs to nobody — never enters a player's ledger. */
  reserveRevenue: number
}

/**
 * Flat, read-only projection of `GameConfig` for the host UI — exactly what the settings
 * panel renders, and nothing more.
 *
 * The full config is deliberately NOT sent: `hostSnapshot()` is rebuilt and pushed to
 * every connected socket on every bot tick, so shipping the ~60 nested fields the UI
 * never reads would be a real hot-path cost. Derived in `views.ts`, never stored.
 */
export interface HostConfigView {
  /** Cost per tCO2 of emissions left uncovered at settlement. */
  penaltyRate: number
  /** Auctioning supply = auctionCapRatio × Σbaseline (host-tunable, ≤ 1 = scarcer). */
  auctionCapRatio: number
  /** Auction supply and benchmark shrink by this factor each year (EU-ETS LRF); 1 = flat. */
  capReductionFactor: number
  /** Benchmarking mode: free credits per company, by industry. */
  benchmark: Record<Industry, number>
  /** Sector averages the benchmark is set against, so the panel's "% below" hint follows
   *  a scenario that changed the emission ranges. */
  sectorAverage: Record<Industry, number>
  /** Read-only display of the active MAC curve per sector. */
  abatement: Record<Industry, AbatementSpec>
  /** Most of its un-abated emissions a company may cut across the WHOLE game. */
  abatementLifetimeCap: number
  /** Retrofit fee per install step, × the company's baseline emission. */
  abatementFixedCost: number
  /** Cost containment reserve: whether it is armed, and the ladder it would release on. */
  reserveEnabled: boolean
  reserveSteps: { triggerPrice: number; cumulativeFraction: number }[]
}

export interface GameState {
  roomCode: string
  seed: number
  capMode: CapMode | null
  phase: Phase
  currentYear: number
  players: Player[]
  years: Record<number, YearRecord>
  config: GameConfig
  /** Computed once when leaving the lobby; fixed across years (see OQ-2 in the plan). */
  freeCreditLimit: number | null
}

// ---- Role-scoped views sent over the wire ----

export interface PublicPlayerInfo {
  id: string
  name: string
  industry: Industry
  connected: boolean
  isBot?: boolean
  botType?: BotType
}

/** What a player knows about themself in the current year. */
export interface YouView {
  id: string
  name: string
  industry: Industry
  emissions: Record<number, number>
  score: number
  freeAllocation: number | null
  /** Auctioning mode: this company's submitted bid. */
  auctionBid: { qty: number; price: number } | null
  /** Auctioning mode: credits won at the auction. */
  auctionAward: number | null
  /**
   * This company's executed trades. Its *open orders* are not carried here — the trade
   * screen reads them out of `market.bids`/`market.asks` filtered by player id, so a
   * `myOrders` copy was pure duplicated payload.
   */
  myTrades: Trade[]
  /** Installed capacity cutting THIS year's emissions (0..1). */
  abatementInForce: number | null
  /** Everything paid for. Above `abatementInForce` until next year opens. */
  abatementCommitted: number
  /** Un-abated emissions — the base every fraction on this screen is a fraction of. */
  unabatedExpected: number
  /**
   * The retrofit fee this company pays per install step, in euros. Sent as a number rather
   * than as the rule that produces it (`fee × baseline`) so the client cannot compute a
   * different figure from the one it will actually be charged.
   */
  abatementFixedCost: number
  /** EU-ETS carry into this year: banked allowances (+) or make-good debt (−). */
  banked: number | null
  /** free + regulatorGranted + banked + net traded, this year. */
  creditsHeld: number | null
  /**
   * The mean this year's emissions are drawn around — capacity already in force applied.
   * This is what the company must actually cover, and it does NOT move when the slider
   * moves: a retrofit bought today changes next year's number, never this one.
   */
  plannedEmission: number
  /** Last year's realized, before this year's capacity. Kept for the history chart. */
  expectedEmission: number | null
  /** Actual emission — revealed only at year end (settlement). */
  realized: number | null
  netPosition: number | null
  settlement: PlayerSettlement | null
}

export interface LeaderboardRow {
  id: string
  name: string
  industry: Industry
  /** Raw cumulative cost. */
  score: number
  /**
   * Emitters: (score − optimalScore) / baseline — skill vs own optimum, lowest wins.
   * Pure-trader bots (MM/speculator): raw cumulative P&L (skill-vs-optimum is
   * meaningless for a ~0-emission financial player); they sort after the emitters.
   */
  normalizedScore: number
  isBot?: boolean
  botType?: BotType
}

export interface PlayerSnapshot {
  role: 'player'
  roomCode: string
  capMode: CapMode | null
  phase: Phase
  currentYear: number
  playerCount: number
  roster: PublicPlayerInfo[]
  /** This player's sector MAC curve, for the live abatement-cost preview. The client
   *  evaluates it with the same shared functions the server settles with. */
  abatement: AbatementSpec
  /** Most of its un-abated emissions this company may EVER cut — the slider's ceiling, and
   *  a lifetime budget rather than a per-year limit. The server clamps to the same number,
   *  so this is a UI affordance, not the enforcement. */
  abatementLifetimeCap: number
  /** Auctioning mode: total supply on offer this year (= the cap). */
  auctionSupply: number
  /** Auctioning mode: uniform clearing price, once the auction has closed. */
  auctionPrice: number | null
  /** Benchmarking mode: this year's tightened benchmark for the player's sector. */
  sectorBenchmark: number | null
  /** Benchmarking mode: the sector average the benchmark is set below. */
  sectorAverage: number | null
  /** Previous settled year's discovered market price (VWAP) — a price signal. */
  prevMarketPrice: number | null
  /** Live order-book market (visible during trade and once settled). */
  market: MarketView | null
  classAggregate: ClassAggregate | null
  leaderboard: LeaderboardRow[] | null // visible from yearSummary on
  you: YouView
}

export interface IndustryBreakdownRow {
  industry: Industry
  players: number
  allocated: number
  realized: number | null
}

export interface ClassAggregate {
  totalBaselineEmissions: number
  totalFreeAllocation: number | null
  totalRegulatorRequests: number | null
  submittedCount: number
  /** Σ expected emissions — the mean the class plans against, before realization. */
  totalExpected: number | null
  totalRealized: number | null
  /** Total cost accrued this year across the class (purchases + penalties). */
  totalCostThisYear: number | null
  industryBreakdown: IndustryBreakdownRow[]
  /** Total emissions vs cap per completed year, for the class chart. */
  yearHistory: { year: number; totalRealized: number; cap: number }[]
  /** Cost containment reserve this year: the pot it was sized at, and what it has sold.
   *  Both 0 when the reserve is disabled or the year opened with no shortfall. */
  reservePot: number
  reserveReleased: number
}

export interface HostPlayerRow extends PublicPlayerInfo {
  baselineEmission: number
  windowSum: number
  score: number
  freeAllocation: number | null
  regulatorGranted: number | null
  /** Net credits bought (+) or sold (−) in the market this year. */
  traded: number | null
  abatement: number | null
  /** EU-ETS carry into this year: banked (+) or debt (−). */
  banked: number | null
  creditsHeld: number | null
  expectedEmission: number
  realized: number | null
  netPosition: number | null
  settlement: PlayerSettlement | null
}

/** One completed/in-progress year of a single company, for the host history view. */
export interface PlayerHistoryYear {
  year: number
  expected: number
  realized: number | null
  free: number
  regulatorGranted: number
  /** Net credits traded in the market (bought − sold). */
  traded: number
  abatement: number
  /** EU-ETS carry into this year: banked (+) or debt (−). */
  banked: number
  creditsHeld: number
  netPosition: number | null
  settlement: PlayerSettlement | null
}

export interface HostSnapshot {
  role: 'host'
  roomCode: string
  capMode: CapMode | null
  phase: Phase
  currentYear: number
  players: HostPlayerRow[]
  classAggregate: ClassAggregate
  regulatorPool: number | null
  config: HostConfigView
  leaderboard: LeaderboardRow[]
  /** Auctioning mode: this year's clearing price (null before the auction closes). */
  auctionPrice: number | null
  /** Previous settled year's discovered market price (VWAP) — a price signal. */
  prevMarketPrice: number | null
  /** Live order-book market. */
  market: MarketView | null
  /** Full year-by-year history per player (host-only). */
  playerHistory: Record<string, PlayerHistoryYear[]>
}

export type Snapshot = PlayerSnapshot | HostSnapshot

import type { Industry } from './constants'

export type CapMode = 'grandfathering' | 'benchmarking' | 'auctioning'

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
}

export interface PlayerSettlement {
  shortage: number
  /** Cost of the emission cuts the company invested in this year. */
  abatementCost: number
  /** (regulatorGranted + secondaryBought) × regulatorPrice for the year. */
  purchaseCost: number
  /** secondarySold × sellPrice — income from selling credits back. */
  sellIncome: number
  /** shortage × penaltyRate. */
  penaltyCost: number
  /** abatementCost + purchaseCost − sellIncome + penaltyCost. */
  yearCost: number
}

export interface YearRecord {
  year: number
  freeAllocation: Record<string, number>
  /** Credits each player asked to buy from the regulator (cap stage). */
  regulatorRequest: Record<string, number>
  /** Credits actually granted after pro-rata against the pool. */
  regulatorGranted: Record<string, number>
  /** Yearly regulator pool = Σbaseline − Σ freeAllocation. */
  regulatorPool: number
  realized: Record<string, number>
  /** Credits bought at the fixed price in the trade stage (unlimited). */
  secondaryBought: Record<string, number>
  /** Credits sold back at the sell price in the trade stage. */
  secondarySold: Record<string, number>
  /** Fraction of expected emissions each company chose to abate (0..1). */
  abatement: Record<string, number>
  /** Auctioning mode: each company's sealed bid at the cap stage. */
  auctionBid: Record<string, { qty: number; price: number }>
  /** Auctioning mode: uniform clearing price after the auction closes. */
  auctionPrice: number | null
  settlement: Record<string, PlayerSettlement> | null
  netPosition: Record<string, number>
}

export interface SessionConfig {
  freeCreditRatio: number
  historyWindow: number
  baselineYear: number
  /** Fixed price per credit bought (regulator cap stage + secondary market). Real cost. */
  regulatorPrice: number
  /** Income per credit sold back in the trade stage. */
  sellPrice: number
  /** Cost per tCO2 of emissions left uncovered at settlement. */
  penaltyRate: number
  /** Benchmarking mode: free credits per company, by industry. */
  benchmark: Record<Industry, number>
  /** Per-sector marginal abatement cost coefficients (MAC = a + b·fraction). */
  abatement: Record<Industry, { a: number; b: number }>
  /** Auctioning supply = auctionCapRatio × Σbaseline (host-tunable, ≤ 1 = scarcer). */
  auctionCapRatio: number
}

export interface GameState {
  roomCode: string
  seed: number
  capMode: CapMode | null
  phase: Phase
  currentYear: number
  players: Player[]
  years: Record<number, YearRecord>
  config: SessionConfig
  /** Computed once when leaving the lobby; fixed across years (see OQ-2 in the plan). */
  freeCreditLimit: number | null
}

// ---- Role-scoped views sent over the wire ----

export interface PublicPlayerInfo {
  id: string
  name: string
  industry: Industry
  connected: boolean
}

/** What a player knows about themself in the current year. */
export interface YouView {
  id: string
  name: string
  industry: Industry
  emissions: Record<number, number>
  score: number
  freeAllocation: number | null
  regulatorRequest: number | null
  regulatorGranted: number | null
  /** Auctioning mode: this company's submitted bid. */
  auctionBid: { qty: number; price: number } | null
  /** Auctioning mode: credits won at the auction (= regulatorGranted). */
  auctionAward: number | null
  /** Credits bought at the fixed price in the trade stage. */
  secondaryBought: number | null
  /** Credits sold back in the trade stage. */
  secondarySold: number | null
  /** Fraction of expected emissions this company chose to abate (0..1). */
  abatement: number | null
  /** free + regulatorGranted + secondaryBought − secondarySold, this year. */
  creditsHeld: number | null
  /** Mean emission players plan against; known from the cap stage on. */
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
  /** (score − optimalScore) / baseline — skill vs the company's own optimum; lowest wins. */
  normalizedScore: number
}

export interface PlayerSnapshot {
  role: 'player'
  roomCode: string
  capMode: CapMode | null
  phase: Phase
  currentYear: number
  playerCount: number
  roster: PublicPlayerInfo[]
  freeCreditLimit: number | null
  regulatorPool: number | null
  regulatorRequestTotal: number | null
  /** Per-player cap on a cap-stage request: (regulatorPool / playerCount) × 2. */
  regulatorRequestCap: number
  regulatorPrice: number
  sellPrice: number
  /** This player's sector MAC coefficients, for live abatement-cost preview. */
  abatementCoeff: { a: number; b: number }
  /** Auctioning mode: total supply on offer this year (= the cap). */
  auctionSupply: number
  /** Auctioning mode: uniform clearing price, once the auction has closed. */
  auctionPrice: number | null
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
  freeCreditLimit: number | null
  totalFreeAllocation: number | null
  totalRegulatorRequests: number | null
  totalRegulatorGranted: number | null
  submittedCount: number
  /** Σ expected emissions — the mean the class plans against, before realization. */
  totalExpected: number | null
  totalRealized: number | null
  totalNetPosition: number | null
  /** Total cost accrued this year across the class (purchases + penalties). */
  totalCostThisYear: number | null
  industryBreakdown: IndustryBreakdownRow[]
  /** Total emissions vs cap per completed year, for the class chart. */
  yearHistory: { year: number; totalRealized: number; cap: number }[]
}

export interface HostPlayerRow extends PublicPlayerInfo {
  baselineEmission: number
  windowSum: number
  score: number
  freeAllocation: number | null
  regulatorRequest: number | null
  regulatorGranted: number | null
  secondaryBought: number | null
  secondarySold: number | null
  abatement: number | null
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
  secondaryBought: number
  secondarySold: number
  abatement: number
  creditsHeld: number
  netPosition: number | null
  settlement: PlayerSettlement | null
}

export interface HostSnapshot {
  role: 'host'
  roomCode: string
  seed: number
  capMode: CapMode | null
  phase: Phase
  currentYear: number
  players: HostPlayerRow[]
  classAggregate: ClassAggregate
  freeCreditLimit: number | null
  regulatorPool: number | null
  config: SessionConfig
  leaderboard: LeaderboardRow[]
  /** Auctioning mode: this year's clearing price (null before the auction closes). */
  auctionPrice: number | null
  /** Full year-by-year history per player (host-only). */
  playerHistory: Record<string, PlayerHistoryYear[]>
}

export type Snapshot = PlayerSnapshot | HostSnapshot

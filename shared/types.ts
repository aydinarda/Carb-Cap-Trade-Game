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
  /** Cumulative cost across years (credit spend + penalties) — lowest wins. */
  score: number
}

export interface PlayerSettlement {
  shortage: number
  /** (regulatorGranted + secondaryBought) × regulatorPrice for the year. */
  purchaseCost: number
  /** shortage × penaltyRate. */
  penaltyCost: number
  /** purchaseCost + penaltyCost — added to the cumulative score. */
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
  settlement: Record<string, PlayerSettlement> | null
  netPosition: Record<string, number>
}

export interface SessionConfig {
  freeCreditRatio: number
  historyWindow: number
  baselineYear: number
  /** Fixed price per credit bought (regulator cap stage + secondary market). Real cost. */
  regulatorPrice: number
  /** Cost per tCO2 of emissions left uncovered at settlement. */
  penaltyRate: number
  /** Benchmarking mode: free credits per company, by industry. */
  benchmark: Record<Industry, number>
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
  /** Credits bought at the fixed price in the trade stage. */
  secondaryBought: number | null
  /** free + regulatorGranted + secondaryBought, this year. */
  creditsHeld: number | null
  realized: number | null
  netPosition: number | null
  settlement: PlayerSettlement | null
}

export interface LeaderboardRow {
  id: string
  name: string
  industry: Industry
  score: number
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
  regulatorPrice: number
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
  creditsHeld: number | null
  realized: number | null
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
}

export type Snapshot = PlayerSnapshot | HostSnapshot

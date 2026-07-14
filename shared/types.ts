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
  /** Cumulative penalty points across years — lowest wins. */
  penaltyPoints: number
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

export interface PlayerSettlement {
  shortage: number
  /** Part of the shortage covered by leftover unsold market credits (low penalty). */
  coveredByLeftover: number
  penalty: number // covered×lowRate + uncovered×highRate
}

export interface YearRecord {
  year: number
  freeAllocation: Record<string, number>
  /** Credits each player asked to buy from the regulator (cap stage). */
  regulatorRequest: Record<string, number>
  /** Credits actually granted after pro-rata against the pool. */
  regulatorGranted: Record<string, number>
  /** Yearly regulator pool = Σbaseline × (1 − freeCreditRatio). */
  regulatorPool: number
  realized: Record<string, number>
  orders: Order[]
  trades: Trade[]
  settlement: Record<string, PlayerSettlement> | null
  leftoverDistributed: number
  netPosition: Record<string, number>
}

export interface SessionConfig {
  freeCreditRatio: number
  historyWindow: number
  baselineYear: number
  /** Fixed regulator sale price (informational — no cash ledger). */
  regulatorPrice: number
  lowPenaltyRate: number
  highPenaltyRate: number
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

/** What a player knows about themself in the current year. */
export interface YouView {
  id: string
  name: string
  industry: Industry
  emissions: Record<number, number>
  penaltyPoints: number
  freeAllocation: number | null
  regulatorRequest: number | null
  regulatorGranted: number | null
  /** free + granted + bought − sold, this year. */
  creditsHeld: number | null
  realized: number | null
  netPosition: number | null
  settlement: PlayerSettlement | null
  myOrders: Order[]
  myTrades: Trade[]
}

export interface LeaderboardRow {
  id: string
  name: string
  industry: Industry
  penaltyPoints: number
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
  market: MarketView | null
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
  totalPenaltyThisYear: number | null
  leftoverDistributed: number | null
  industryBreakdown: IndustryBreakdownRow[]
  /** Total emissions vs cap per completed year, for the class chart. */
  yearHistory: { year: number; totalRealized: number; cap: number }[]
}

export interface HostPlayerRow extends PublicPlayerInfo {
  baselineEmission: number
  windowSum: number
  penaltyPoints: number
  freeAllocation: number | null
  regulatorRequest: number | null
  regulatorGranted: number | null
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
  market: MarketView | null
  leaderboard: LeaderboardRow[]
}

export type Snapshot = PlayerSnapshot | HostSnapshot

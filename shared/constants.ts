export const INDUSTRIES = {
  'Power & Utilities': { low: 850, high: 1150 },
  'Heavy Materials': { low: 650, high: 950 },
  'Manufacturing & Chemicals': { low: 350, high: 700 },
  Transport: { low: 150, high: 450 },
} as const

export type Industry = keyof typeof INDUSTRIES

export const INDUSTRY_NAMES = Object.keys(INDUSTRIES) as Industry[]

export const INDUSTRY_PROBS = [0.25, 0.25, 0.25, 0.25]

export const FREE_CREDIT_RATIO = 0.8
export const HISTORY_WINDOW = 10
export const BASELINE_YEAR = 10
export const FIRST_GAME_YEAR = 11

// Host-adjustable defaults
export const DEFAULT_REGULATOR_PRICE = 10 // real cost per credit bought (regulator + secondary market)
export const DEFAULT_PENALTY_RATE = 20 // cost per tCO2 left uncovered — kept above the credit price so covering beats defaulting

/**
 * Benchmarking free allocation: every company in an industry gets this many
 * free credits regardless of its own history. Defaults are ~80% of each
 * industry's midpoint so the totals are comparable to grandfathering; the host
 * can tune them.
 */
export const DEFAULT_BENCHMARK: Record<Industry, number> = {
  'Power & Utilities': 800,
  'Heavy Materials': 640,
  'Manufacturing & Chemicals': 420,
  Transport: 240,
}

export const MIN_PLAYERS = 1
export const MAX_PLAYERS = 60

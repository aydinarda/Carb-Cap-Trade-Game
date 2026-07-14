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
export const DEFAULT_REGULATOR_PRICE = 10 // informational — no cash ledger yet
export const DEFAULT_LOW_PENALTY_RATE = 1 // points per tCO2 covered by leftover credits
export const DEFAULT_HIGH_PENALTY_RATE = 3 // points per tCO2 left uncovered

export const MIN_PLAYERS = 1
export const MAX_PLAYERS = 60

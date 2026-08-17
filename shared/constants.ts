export const INDUSTRIES = {
  'Power & Utilities': { low: 850, high: 1150 },
  'Heavy Materials': { low: 650, high: 950 },
  'Manufacturing & Chemicals': { low: 350, high: 700 },
  Transport: { low: 150, high: 450 },
} as const

export type Industry = keyof typeof INDUSTRIES

export const INDUSTRY_NAMES = Object.keys(INDUSTRIES) as Industry[]

export const FREE_CREDIT_RATIO = 0.8
export const HISTORY_WINDOW = 10
export const BASELINE_YEAR = 10
export const FIRST_GAME_YEAR = 11

/**
 * Realized emissions are drawn from each company's own distribution, centred on
 * its expected (mean) emission — the most recent known level — with this
 * standard deviation as a fraction of the mean. Players plan against the mean;
 * the actual realization (revealed only at year end) can differ by this spread.
 */
export const EMISSION_VOLATILITY = 0.08

// Host-adjustable defaults
export const DEFAULT_PENALTY_RATE = 20 // cost per tCO2 left uncovered — the effective ceiling on the market price
export const DEFAULT_AUCTION_CAP_RATIO = 1.0 // auctioning supply = this × Σbaseline; host-tunable (lower = scarcer, stronger price signal)
export const DEFAULT_CAP_REDUCTION_FACTOR = 0.97 // auction supply shrinks by this factor each year (EU-ETS LRF); 0.97 = −3%/yr, 1 = flat

/**
 * Sector average annual emission — the midpoint of the generation range above.
 * Derived rather than hardcoded so it can never drift from INDUSTRIES.
 * Power & Utilities 1000 · Heavy Materials 800 · Manufacturing & Chemicals 525 · Transport 300
 */
export const SECTOR_AVERAGE_EMISSIONS = Object.fromEntries(
  INDUSTRY_NAMES.map((i) => [i, (INDUSTRIES[i].low + INDUSTRIES[i].high) / 2]),
) as Record<Industry, number>

/**
 * EU-style benchmark stringency. A real benchmark is the average emission
 * intensity of the most efficient 10% of installations in the sector; here we
 * approximate that with a flat cut — the benchmark sits 40% below the sector
 * average. An average company is therefore structurally short and must cut
 * emissions or buy on the secondary market; only a genuinely efficient one is long.
 */
export const BENCHMARK_STRINGENCY = 0.6

/**
 * Benchmarking free allocation: every company in an industry gets this many free
 * credits regardless of its own history. The host can tune them per sector.
 * 600 / 480 / 315 / 180 at the default stringency.
 */
export const DEFAULT_BENCHMARK = Object.fromEntries(
  INDUSTRY_NAMES.map((i) => [
    i,
    Math.round(SECTOR_AVERAGE_EMISSIONS[i] * BENCHMARK_STRINGENCY * 10) / 10,
  ]),
) as Record<Industry, number>

/**
 * Pure-trader bots (market makers, speculators) get no free allocation, so under a
 * mode with no primary auction they would have nothing to quote asks against. They
 * buy an opening book at the reference price instead — these size that purchase.
 */
export const BOT_SEED_MM_FRAC = 0.18 // × the class's free allocation; mirrors MM_INV_FRAC
export const BOT_SEED_SPEC = 20 // flat; mirrors SPEC_INIT_INV

/**
 * Per-sector marginal abatement cost (MAC): cost to cut the f-th fraction of a
 * company's emissions is `a + b·f` per tonne (rising — cheap cuts first). The
 * optimal cut is where MAC meets the carbon price: r* = (price − a)/b. Sectors
 * differ (some decarbonise cheaply, some not), and the host can tune these.
 */
export const DEFAULT_ABATEMENT: Record<Industry, { a: number; b: number }> = {
  'Power & Utilities': { a: 2, b: 15 }, // cheap (renewables) → cuts a lot
  'Manufacturing & Chemicals': { a: 4, b: 20 },
  Transport: { a: 5, b: 20 },
  'Heavy Materials': { a: 8, b: 30 }, // hard (cement/steel) → cuts little
}

export const MAX_PLAYERS = 60

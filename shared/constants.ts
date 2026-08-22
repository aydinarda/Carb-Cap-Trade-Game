/**
 * Sector definitions and the tables derived from them.
 *
 * Everything tunable now lives in `shared/config` — this file is the remaining source of
 * truth for the SET of sectors, because `Industry` is a TypeScript type derived from
 * these keys and so cannot be configured at runtime. The per-sector NUMBERS here seed
 * `DEFAULT_GAME_CONFIG` and can be overridden per session.
 */
export const INDUSTRIES = {
  'Power & Utilities': { low: 850, high: 1150 },
  'Heavy Materials': { low: 650, high: 950 },
  'Manufacturing & Chemicals': { low: 350, high: 700 },
  Transport: { low: 150, high: 450 },
} as const

export type Industry = keyof typeof INDUSTRIES

export const INDUSTRY_NAMES = Object.keys(INDUSTRIES) as Industry[]

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
 * Per-sector marginal abatement cost (MAC): cost to cut the f-th fraction of a
 * company's emissions is `a + b·f` per tonne (rising — cheap cuts first). The
 * optimal cut is where MAC meets the carbon price: r* = (price − a)/b. Sectors
 * differ (some decarbonise cheaply, some not), and the host can tune these.
 */
export const DEFAULT_ABATEMENT: Record<Industry, { a: number; b: number }> = {
  'Power & Utilities': { a: 10, b: 75 }, // cheap (renewables) → cuts a lot
  'Manufacturing & Chemicals': { a: 20, b: 100 },
  Transport: { a: 25, b: 100 },
  'Heavy Materials': { a: 40, b: 150 }, // hard (cement/steel) → cuts little
}

/**
 * Counterparty id for the cost containment reserve.
 *
 * The reserve is deliberately NOT a `Player`: everything that walks `state.players` would
 * otherwise see it — `realizeYear` would give it an emission, `settleYear` a settlement row,
 * and the leaderboard would rank its sale proceeds first every single year. `matchOrder` is
 * purely string-keyed, so a bare id is all the order book needs. Cannot collide with a
 * player id, which is always `P${n}`.
 */
export const RESERVE_ID = 'RESERVE'

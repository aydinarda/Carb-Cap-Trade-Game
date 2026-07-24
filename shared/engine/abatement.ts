import { round1 } from './rng'

export interface AbatementCoeff {
  /** Marginal cost of the first (fraction→0) tonne abated. */
  a: number
  /** How fast the marginal cost rises with the fraction abated. */
  b: number
}

/**
 * Total cost to abate a fraction `r` of a company's expected emission. Marginal
 * cost per tonne at fraction f is `a + b·f`, so integrating over 0..r and
 * scaling by the emission level E gives E·(a·r + b·r²/2). Convex: cheap cuts
 * first, then progressively dearer.
 */
export function abatementCost(expected: number, fraction: number, coeff: AbatementCoeff): number {
  const r = Math.max(0, Math.min(1, fraction))
  return round1(expected * (coeff.a * r + (coeff.b * r * r) / 2))
}

/** Cost-minimising abatement fraction: where marginal cost meets the price, clamped to [0,1]. */
export function optimalAbatement(coeff: AbatementCoeff, price: number): number {
  if (coeff.b <= 0) return price > coeff.a ? 1 : 0
  return Math.max(0, Math.min(1, (price - coeff.a) / coeff.b))
}

/**
 * The minimum achievable expected cost for a company playing perfectly: abate to
 * r*, then cover the residual against its free credits — buy the shortfall at
 * buyPrice or sell the surplus at sellPrice. Used as the per-company benchmark so
 * the leaderboard measures skill (distance from optimum), not sector/size luck.
 */
export function optimalYearCost(
  expected: number,
  free: number,
  coeff: AbatementCoeff,
  buyPrice: number,
  sellPrice: number,
): number {
  const r = optimalAbatement(coeff, buyPrice)
  const abated = expected * (1 - r)
  const cover = abated >= free ? buyPrice * (abated - free) : -sellPrice * (free - abated)
  return round1(abatementCost(expected, r, coeff) + cover)
}

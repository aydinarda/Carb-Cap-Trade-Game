import {
  parseSpec,
  specIntegral,
  specMarginal,
  specOptimal,
  type AbatementParamsByModel,
  type AbatementSpec,
} from './abatementModels'
import { round1 } from './rng'

export type { AbatementSpec }

/**
 * The original linear shorthand. Callers that still pass a bare `{a, b}` are read as
 * `{ model: 'linear', params: {a, b} }` — this keeps every existing call site and test
 * working while the engine migrates to full specs.
 */
export type AbatementCoeff = AbatementParamsByModel['linear']

/** Either a full model spec or the legacy bare linear coefficients. */
export type AbatementInput = AbatementSpec | AbatementCoeff

export function toSpec(input: AbatementInput): AbatementSpec {
  return 'model' in input ? input : { model: 'linear', params: input }
}

/**
 * Marginal cost of the next tonne at abatement fraction `f`, per tonne.
 * Deliberately NOT rounded — the bots derive their reservation and fair prices from
 * this, and quantizing it would move every quote by up to half a tick.
 */
export function marginalCost(fraction: number, input: AbatementInput): number {
  return specMarginal(fraction, toSpec(input))
}

/**
 * Total cost to abate a fraction `r` of a company's expected emission: the integral of
 * the marginal cost curve over 0..r, scaled by the emission level. Convex for every
 * shipped model — cheap cuts first, then progressively dearer.
 */
export function abatementCost(
  expected: number,
  fraction: number,
  input: AbatementInput,
): number {
  return round1(expected * specIntegral(fraction, toSpec(input)))
}

/** Cost-minimising abatement fraction: where marginal cost meets the price, clamped to [0,1]. */
export function optimalAbatement(input: AbatementInput, price: number): number {
  return specOptimal(price, toSpec(input))
}

/**
 * The minimum achievable expected cost for a company playing perfectly: abate to
 * r*, then settle the residual against its free credits at the market price — buy
 * the shortfall or sell the surplus, both at `price`. Used as the per-company
 * benchmark so the leaderboard measures skill (distance from optimum), not luck.
 */
export function optimalYearCost(
  expected: number,
  free: number,
  input: AbatementInput,
  price: number,
): number {
  const spec = toSpec(input)
  const r = specOptimal(price, spec)
  const abated = expected * (1 - r)
  // cover > 0 → buy the shortfall; cover < 0 → sell the surplus (income).
  return round1(abatementCost(expected, r, spec) + price * (abated - free))
}

export { parseSpec }

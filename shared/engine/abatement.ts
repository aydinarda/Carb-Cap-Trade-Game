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

/**
 * Cost-minimising abatement fraction: where marginal cost meets the price.
 *
 * `maxFraction` is the physical ceiling on how much of a year's emissions a company can
 * cut (`config.abatement.maxFraction`). Above it the curve is irrelevant — no price buys a
 * cut that cannot be made — so demand becomes perfectly inelastic there. Callers that omit
 * it get the unbounded optimum, which is only correct for questions about the curve itself.
 */
export function optimalAbatement(
  input: AbatementInput,
  price: number,
  maxFraction = 1,
): number {
  return Math.min(specOptimal(price, toSpec(input)), clamp01(maxFraction))
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/**
 * The minimum achievable expected cost for a company playing perfectly: abate to
 * r*, then settle the residual against the credits it holds — buy the shortfall or
 * sell the surplus. Used as the per-company benchmark so the leaderboard measures
 * skill (distance from optimum), not luck or which sector the player drew.
 *
 * `credits` is everything the company starts the year with, INCLUDING the carry: a
 * banked surplus is real credits it can sell, and a make-good debt is real credits
 * it must replace. Leaving the carry out made the benchmark assume a debtor had
 * allowances it did not have, which inflated its measured skill gap year after year
 * and effectively punished the same debt a third time (after the fine and the
 * obligation itself).
 *
 * `penaltyRate` caps what covering a shortfall can cost: nobody playing perfectly
 * pays more than the fine to buy an allowance, so the residual is settled at
 * min(price, penaltyRate). Surplus is always sold at the market price.
 */
export function optimalYearCost(
  expected: number,
  credits: number,
  input: AbatementInput,
  price: number,
  penaltyRate?: number,
  maxFraction = 1,
): number {
  const spec = toSpec(input)
  // Perfect play cannot cut more than the plant physically can, so the benchmark the
  // leaderboard scores against must respect the same ceiling the player is held to.
  const r = optimalAbatement(spec, price, maxFraction)
  const abated = expected * (1 - r)
  const cover = abated - credits // > 0 → buy the shortfall; < 0 → sell the surplus
  const coverRate =
    cover > 0 && penaltyRate !== undefined ? Math.min(price, penaltyRate) : price
  return round1(abatementCost(expected, r, spec) + coverRate * cover)
}

export { parseSpec }

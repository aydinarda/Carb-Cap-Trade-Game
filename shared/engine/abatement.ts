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
 * `maxFraction` is a ceiling on the answer — usually `config.abatement.lifetimeCap`, or the
 * headroom left under it. Above it the curve is irrelevant — no price buys a cut that cannot
 * be made — so demand becomes perfectly inelastic there. Callers that omit it get the
 * unbounded optimum, which is only correct for questions about the curve itself.
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
 * What it costs to raise installed capacity from `from` to `to`, as a fraction of the
 * company's **un-abated** emissions.
 *
 * Two parts, and the split is the whole point of the model:
 *  - a **fixed retrofit fee**, charged in full on every step, however small;
 *  - the **variable** cost of the new slice only — the MAC integral from `from` to `to`.
 *
 * Because the integral is additive (∫₀^0.1 + ∫₀.₁^0.5 = ∫₀^0.5), the variable halves sum to
 * the same total whatever path a company takes. The *only* difference between installing 50%
 * in one move and installing 10% then 40% is one extra fee. That identity is the user's
 * specification and `abatement.spec.ts` pins it to the cent.
 *
 * `unabated` is emissions measured against the no-abatement counterfactual, NOT this year's
 * post-cut expectation — see `unabatedFrom`. Using the latter would make each successive
 * slice cheaper than the curve says it is.
 *
 * Returns 0 for a non-increase: there is no such thing as un-installing, and no refund.
 */
export function installCost(
  unabated: number,
  from: number,
  to: number,
  input: AbatementInput,
  fixedCost: number,
): number {
  if (!(to > from)) return 0
  const spec = toSpec(input)
  const variable = unabated * (specIntegral(to, spec) - specIntegral(from, spec))
  return round1(Math.max(0, fixedCost) + variable)
}

/**
 * The one-year cut to hand `realizeYear` so that a *persistent* capacity level does not
 * compound into oblivion.
 *
 * `realizeYear` draws around `expected × (1 − r)`, and `expected` is last year's realized.
 * Feeding it the standing level every year therefore applies the cut again and again: hold
 * 50% and emissions run 0.5ⁿ — 3% of baseline by year five, with the market dead well before
 * that. Feeding it the *increment* instead makes the composition telescope, so realized
 * emissions equal the un-abated random walk times (1 − now). Installed capacity then holds
 * its level, which is what a retrofit actually does.
 *
 * `prev >= 1` means everything was already cut and there is nothing left to take.
 */
export function incrementalFraction(now: number, prev: number): number {
  if (prev >= 1) return 0
  return clamp01(1 - (1 - clamp01(now)) / (1 - clamp01(prev)))
}

/**
 * Reconstructs the un-abated level from an expectation that already has `embedded` baked
 * into it. The inverse of the `× (1 − r)` in `realizeYear`, and the denominator every
 * install decision is sized against.
 *
 * `embedded >= 1` is degenerate (a company cut to literally zero, reachable only with
 * `lifetimeCap: 1`); returning 0 keeps a divide-by-zero out of every score downstream.
 */
export function unabatedFrom(expected: number, embedded: number): number {
  const e = clamp01(embedded)
  return e >= 1 ? 0 : expected / (1 - e)
}

export interface InstallPlan {
  /** The level to install to. Equals `committed` when the plan is to do nothing. */
  target: number
  /** What that step would cost, fee included. */
  cost: number
  /** Undiscounted savings over the horizon, for diagnostics. */
  gain: number
  install: boolean
}

/**
 * Whether an **agent** should install more capacity, and how much.
 *
 * Lives here rather than in each bot so that the compliance bot, the noise bot, the
 * simulated students and the load harness cannot drift apart on the one decision in the
 * game that is genuinely intertemporal.
 *
 * **Size myopically, gate on payback.** The target is the ordinary `r*(price)` — where the
 * marginal tonne costs what a tonne costs — and the fee is then tested against `horizon`
 * years of savings at today's price. The obvious alternative (size at `r*(horizon × price)`,
 * valuing the capacity over its life) collapses the game: at a 3-year horizon and €60 it
 * clamps every sector to the lifetime cap, so everyone maxes out in year one and both the
 * fee and the stepping question stop mattering. Sizing myopically keeps sectors
 * heterogeneous and produces genuine top-ups as the price climbs — a second step, a second
 * fee, which is the lesson the fee exists to teach.
 *
 * `minStep` blocks nibbling: without it an agent pays a full fee for a 1% slice as soon as
 * the price ticks up. The horizon is undiscounted on purpose — this is a classroom agent,
 * and a discount rate is one more unexplained number on the host panel.
 */
export function planInstall(args: {
  spec: AbatementInput
  /** Price the agent believes in — already biased/adjusted by the caller. */
  price: number
  /** Un-abated emissions, i.e. the base the fractions are fractions of. */
  unabated: number
  /** Capacity already paid for. */
  committed: number
  lifetimeCap: number
  fixedCost: number
  horizon: number
  minStep?: number
}): InstallPlan {
  const { spec, price, unabated, committed, lifetimeCap, fixedCost, horizon } = args
  const minStep = args.minStep ?? 0.05
  const ceiling = Math.max(committed, clamp01(lifetimeCap))
  const target = Math.min(ceiling, Math.max(committed, optimalAbatement(spec, price)))
  const step = target - committed
  const cost = installCost(unabated, committed, target, spec, fixedCost)
  const gain = horizon * price * unabated * step
  return { target, cost, gain, install: step >= minStep && gain > cost }
}

/**
 * The minimum achievable cost for a company playing this year perfectly: take this year's
 * emissions as given, and settle them against the credits it holds — buy the shortfall or
 * sell the surplus. Used as the per-company benchmark so the leaderboard measures skill
 * (distance from optimum), not luck or which sector the player drew.
 *
 * **Abatement is not a decision this benchmark makes.** Capacity is installed a year ahead,
 * so by the time the year is scored, `planned` is fixed and the money is spent: both are
 * sunk. `abatementSpend` is therefore passed straight through to both sides of
 * `score − optimalScore`, where it cancels.
 *
 * The stated consequence, which is a real cost of the lag and not an oversight: **this
 * leaderboard now measures trading skill only.** A student who never installs and one who
 * installs perfectly are indistinguishable on this axis. Scoring the investment decision
 * would mean scoring it against a price path nobody knew at the time — a benchmark the
 * class could not have hit, which is worse.
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
 *
 * OPEN QUESTION, under review — do not "fix" this in passing. That cap assumes paying the
 * fine ends the matter, but `settleYear` carries the uncovered tonne forward as a make-good
 * debt, so defaulting really costs the fine PLUS settling the tonne later. The consequence
 * is quantified in `sim/sweeps/price-calibration.ipynb` (§6.5); the shipped behaviour is
 * deliberately unchanged until that has been read.
 */
export function optimalYearCost(
  planned: number,
  credits: number,
  abatementSpend: number,
  price: number,
  penaltyRate?: number,
): number {
  const cover = planned - credits // > 0 → buy the shortfall; < 0 → sell the surplus
  const coverRate =
    cover > 0 && penaltyRate !== undefined ? Math.min(price, penaltyRate) : price
  return round1(abatementSpend + coverRate * cover)
}

export { parseSpec }

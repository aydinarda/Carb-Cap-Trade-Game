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
 * The net worth of an install step, at the price the decision was actually taken at.
 *
 * `horizon` years of savings at `price`, less what the step cost — the same undiscounted
 * arithmetic `planInstall` gates on, exposed so the scorer and the agents cannot disagree
 * about what a retrofit was worth. Doing nothing is worth exactly 0, which is why a step
 * whose fee outruns its savings scores NEGATIVE: over-investing is a mistake in the same
 * currency as under-investing, and the leaderboard should say so.
 */
export function installValue(args: {
  step: number
  cost: number
  unabated: number
  price: number
  horizon: number
}): number {
  const { step, cost, unabated, price, horizon } = args
  if (step <= 0) return 0
  return round1(horizon * price * unabated * step - cost)
}

/**
 * How much value a company left on the table with this year's investment decision.
 *
 * **Why this can be scored at all.** `optimalYearCost` deliberately does not score the
 * investment: capacity is installed a year ahead, so at settlement the spend is sunk and
 * passes through both sides of `score − optimalScore` unchanged. The stated objection to
 * fixing that was that scoring the decision would mean scoring it against a price path
 * nobody knew at the time.
 *
 * This measures it against a price path everybody DID know: `price` is the year the decision
 * was taken in, and the rule it is compared to is `planInstall` — the same myopic
 * size-and-payback rule the compliance bots and the simulated students already follow. So it
 * is a benchmark the class could have hit, using only information the class had.
 *
 * Returns euros of forgone value, never negative: beating the rule (a step the myopic
 * benchmark would not have taken but which paid off at this price) scores 0, not a bonus.
 * The rule is a floor on competence, not a target to be gamed by out-guessing it.
 */
export function investmentGap(args: {
  spec: AbatementInput
  /** The price the decision was taken at — the year's discovered market price. */
  price: number
  /** Un-abated emissions: the base both the step and its savings are fractions of. */
  unabated: number
  /** Capacity already committed when the year opened. */
  committedBefore: number
  /** Capacity committed by the time the year closed. */
  committedAfter: number
  /** What the company actually paid for that step, fees included. */
  actualCost: number
  lifetimeCap: number
  fixedCost: number
  horizon: number
  minStep?: number
}): number {
  const { spec, price, unabated, committedBefore, committedAfter, actualCost } = args
  const yours = installValue({
    step: Math.max(0, committedAfter - committedBefore),
    cost: actualCost,
    unabated,
    price,
    horizon: args.horizon,
  })
  const plan = planInstall({
    spec,
    price,
    unabated,
    committed: committedBefore,
    lifetimeCap: args.lifetimeCap,
    fixedCost: args.fixedCost,
    horizon: args.horizon,
    minStep: args.minStep,
  })
  // `install: false` means the rule would have sat this year out, and sitting out is worth 0.
  const best = plan.install
    ? installValue({
        step: plan.target - committedBefore,
        cost: plan.cost,
        unabated,
        price,
        horizon: args.horizon,
      })
    : 0
  return round1(Math.max(0, best - yours))
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
 * So this function measures **trading skill only**, and that is now deliberate rather than a
 * gap: the investment decision is scored separately by `investmentGap`, against the price
 * that was on screen when it was taken. Keeping them apart is what lets each be measured on
 * its own information — this one on the year that has just closed, that one on the year the
 * decision was made in. The leaderboard combines the two.
 *
 * `endowment` is what the company received WITHOUT paying for it: its free allocation plus
 * the carry. The carry belongs here because a banked surplus is real credits it can sell and
 * a make-good debt is real credits it must replace — leaving it out made the benchmark
 * assume a debtor held allowances it did not have, and punished the same debt a third time
 * (after the fine and the obligation itself).
 *
 * **What it must NOT include is anything the company bought at the auction.** That is the
 * defect this parameter was renamed to fix. `regulatorGranted` used to be counted here, so
 * the benchmark was handed the auction award for free while the player was charged
 * `award × clearingPrice` for it. Under a regime that auctions most of the cap that
 * difference is the player's entire allowance bill, it is identical for everyone, and no
 * decision can avoid it — measured over a balanced ten-year class it put the median gap at
 * 525 €/t of baseline under auctioning against 71 under grandfathering, so a leaderboard
 * comparing the two was mostly reporting which mode was being played.
 *
 * `primaryPrice` is the other half of that fix: where there WAS an auction to bid into, the
 * cheapest way to cover a tonne was the lower of the clearing price and the market, so that
 * is what perfect play paid. Pass it only for a mechanism that actually ran one — under the
 * free-allocation modes the field carries the trader-bot seed price, which no student could
 * buy at. Surplus is always sold at the market price: there is no selling into an auction.
 *
 * **Both sides of the position settle at the market price, and there is no penalty cap.**
 *
 * There used to be one: a shortfall was settled at `min(price, penaltyRate)`, on the reading
 * that nobody playing perfectly pays more than the fine for an allowance. That reading is
 * wrong in this game, and the docstring said so as an open question for as long as it
 * shipped. `settleYear` carries an uncovered tonne forward as a make-good debt on top of the
 * fine, so defaulting costs `penaltyRate` NOW and the tonne LATER — approximately
 * `penaltyRate + price`, which is what `bots.fixes.ceilingIncludesCarry` has been pricing
 * for the agents all along. Since `price ≤ penaltyRate + price` for any non-negative fine,
 * buying is always at least as cheap as defaulting and the cap could never bind for a player
 * actually playing well.
 *
 * What the cap did instead was understate the benchmark whenever the market traded above the
 * fine: it credited a perfect player with covering at €100 while the class was paying €130,
 * so everyone's measured gap absorbed a €30 difference nobody could have avoided. Removing
 * it makes a high-price year score the decisions taken in it rather than the price level.
 */
export function optimalYearCost(
  planned: number,
  endowment: number,
  abatementSpend: number,
  price: number,
  primaryPrice?: number,
): number {
  const cover = planned - endowment // > 0 → buy the shortfall; < 0 → sell the surplus
  const coverRate =
    cover > 0 && primaryPrice !== undefined && primaryPrice > 0
      ? Math.min(price, primaryPrice)
      : price
  return round1(abatementSpend + coverRate * cover)
}

export { parseSpec }

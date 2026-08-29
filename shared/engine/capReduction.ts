import type { GameConfig } from '../config/schema'

/**
 * How much the cap has shrunk by `targetYear`, as a multiplier on the opening allocation.
 *
 * A single `capReductionFactor` raised to the year index compounds, and compounding is why
 * every long game misbehaved: the same number that builds useful scarcity in the early
 * rounds strangles the market by round fifteen. `capReductionSchedule` replaces the exponent
 * with a PRODUCT of per-round factors, so the tightening can decelerate.
 *
 * The two are not alternatives to choose between — the schedule is the rule and
 * `capReductionFactor` is the fallback for a config that does not set one (and for the many
 * tests and scenarios that pin a single factor deliberately).
 *
 * Round 1 is `firstGameYear`, and no reduction applies to it: the opening allocation is the
 * baseline the schedule shrinks FROM. So round 2 carries round 1's factor, round 3 carries
 * rounds 1-2, and so on.
 */
export function cumulativeCapFactor(config: GameConfig, targetYear: number): number {
  const { capReductionFactor, capReductionSchedule } = config.allocation
  const roundsElapsed = targetYear - config.emissions.firstGameYear
  if (roundsElapsed <= 0) return 1
  if (!capReductionSchedule?.length) return Math.pow(capReductionFactor, roundsElapsed)

  // Sorted defensively: a schedule written out of order would otherwise apply the wrong
  // factor to every round after the misplaced entry, silently.
  const steps = [...capReductionSchedule].sort((a, b) => a.fromRound - b.fromRound)
  let product = 1
  for (let round = 1; round <= roundsElapsed; round++) {
    // The factor in force during `round` is the last entry whose `fromRound` has been
    // reached; before the first entry, fall back to the flat factor.
    let factor = capReductionFactor
    for (const step of steps) {
      if (step.fromRound <= round) factor = step.factor
      else break
    }
    product *= factor
  }
  return product
}

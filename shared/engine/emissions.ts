import { DEFAULT_GAME_CONFIG } from '../config/defaults'
import type { Player } from '../types'
import { round1, type Rng } from './rng'

/**
 * A company's expected (mean) emission for a year: its most recent known level.
 * For the first game year that is the baseline (Year 10); afterwards it is the
 * previous year's realized emission, so expectations follow a random walk over
 * the company's own history. This is the only figure players see before trading.
 */
export function expectedEmission(player: Player, year: number): number {
  for (let y = year - 1; y >= 1; y--) {
    const value = player.emissions[y]
    if (value !== undefined) return round1(value)
  }
  return 0
}

/**
 * Draws each company's realized emission for the year from its own distribution:
 * a normal centred on its (post-abatement) expected emission with std
 * `volatility` × mean. Abatement lowers the mean by the chosen fraction.
 * Revealed only at year end (settlement), so trading happens under real
 * uncertainty — the realization can differ from the mean players planned against.
 *
 * `levelFactor` is a class-wide shock on top of that mean — the energy crisis event, and
 * 1 in an ordinary year. A single scalar rather than a per-company map on purpose: a demand
 * shock that hit some companies and not others would be a dice roll dressed as an event, and
 * the symmetry is what makes it safe to spring on a class without warning.
 *
 * It must be the SAME number `Session.plannedFor` multiplies by, because that is what the
 * whole game is shown: `plannedEmission` is documented as the mean this draw is centred on,
 * and every cover decision, the reserve's sizing and the scoring benchmark are taken against
 * it. A shock visible to the draw but not to `plannedFor` would quietly charge the class for
 * tonnes it was never told about.
 */
export function realizeYear(
  players: Player[],
  rng: Rng,
  year: number,
  abatement: Record<string, number> = {},
  volatility: number = DEFAULT_GAME_CONFIG.emissions.volatility,
  levelFactor = 1,
): Record<string, number> {
  const realized: Record<string, number> = {}
  const level = Math.max(0, levelFactor)
  for (const player of players) {
    const r = Math.max(0, Math.min(1, abatement[player.id] ?? 0))
    const mean = expectedEmission(player, year) * (1 - r) * level
    const draw = rng.normal(mean, volatility * mean)
    realized[player.id] = round1(Math.max(0, draw))
  }
  return realized
}

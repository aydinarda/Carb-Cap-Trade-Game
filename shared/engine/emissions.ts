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
 */
export function realizeYear(
  players: Player[],
  rng: Rng,
  year: number,
  abatement: Record<string, number> = {},
  volatility: number = DEFAULT_GAME_CONFIG.emissions.volatility,
): Record<string, number> {
  const realized: Record<string, number> = {}
  for (const player of players) {
    const r = Math.max(0, Math.min(1, abatement[player.id] ?? 0))
    const mean = expectedEmission(player, year) * (1 - r)
    const draw = rng.normal(mean, volatility * mean)
    realized[player.id] = round1(Math.max(0, draw))
  }
  return realized
}

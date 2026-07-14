import { INDUSTRIES } from '../constants'
import type { Player } from '../types'
import { round1, type Rng } from './rng'

/**
 * Draws the target year's realized emissions for every player, uniform within
 * their industry's range (per the notebook). Revealed after the cap stage and
 * before trade.
 */
export function realizeYear(
  players: Player[],
  rng: Rng,
): Record<string, number> {
  const realized: Record<string, number> = {}
  for (const player of players) {
    const { low, high } = INDUSTRIES[player.industry]
    realized[player.id] = round1(rng.uniform(low, high))
  }
  return realized
}

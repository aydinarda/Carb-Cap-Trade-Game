import { round1 } from './rng'

/**
 * Net position per player for a year:
 *   netPosition = realized emissions − credits held
 * Positive = shortage (emitted more than covered), negative = surplus.
 * This is the notebook's `Year_target − credits for Year_target`.
 */
export function computeNetPositions(
  realized: Record<string, number>,
  creditsHeld: Record<string, number>,
): Record<string, number> {
  const net: Record<string, number> = {}
  for (const playerId of Object.keys(realized)) {
    net[playerId] = round1(realized[playerId] - (creditsHeld[playerId] ?? 0))
  }
  return net
}

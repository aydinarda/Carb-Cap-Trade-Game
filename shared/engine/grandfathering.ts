import type { Player, SessionConfig } from '../types'
import type { CapMechanism } from './capMechanism'
import { round1 } from './rng'

/** Sum of a player's emissions over the moving window [targetYear − window, targetYear − 1]. */
export function windowSum(player: Player, targetYear: number, historyWindow: number): number {
  let sum = 0
  for (let year = targetYear - historyWindow; year < targetYear; year++) {
    sum += player.emissions[year] ?? 0
  }
  return sum
}

export function computeFreeCreditLimit(players: Player[], config: SessionConfig): number {
  const totalBaseline = players.reduce(
    (sum, p) => sum + (p.emissions[config.baselineYear] ?? 0),
    0,
  )
  return totalBaseline * config.freeCreditRatio
}

/**
 * Grandfathering (per the notebook): each player's free credits for the target
 * year are proportional to their share of the class's total emissions over the
 * moving 10-year window. Realized years enter the window as the game advances.
 */
export const grandfathering: CapMechanism = {
  mode: 'grandfathering',
  implemented: true,
  computeFreeCreditLimit,
  allocate(players, targetYear, freeCreditLimit, config) {
    const sums = new Map(
      players.map((p) => [p.id, windowSum(p, targetYear, config.historyWindow)]),
    )
    const total = [...sums.values()].reduce((a, b) => a + b, 0)
    const allocation: Record<string, number> = {}
    for (const player of players) {
      allocation[player.id] =
        total > 0 ? round1((sums.get(player.id)! / total) * freeCreditLimit) : 0
    }
    return allocation
  },
}

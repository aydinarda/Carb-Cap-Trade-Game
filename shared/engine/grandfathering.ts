import type { GameConfig } from '../config/schema'
import type { Player } from '../types'
import type { CapMechanism } from './capMechanism'
import { round1 } from './rng'
import { isPureTrader } from './roles'

/** Sum of a player's emissions over the moving window [targetYear − window, targetYear − 1]. */
export function windowSum(player: Player, targetYear: number, historyWindow: number): number {
  let sum = 0
  for (let year = targetYear - historyWindow; year < targetYear; year++) {
    sum += player.emissions[year] ?? 0
  }
  return sum
}

export function computeFreeCreditLimit(players: Player[], config: GameConfig): number {
  const totalBaseline = players.reduce(
    // Pure-trader bots are financial intermediaries with no real history to grandfather,
    // so they neither enlarge the class cap nor draw a share of it.
    (sum, p) => (isPureTrader(p) ? sum : sum + (p.emissions[config.emissions.baselineYear] ?? 0)),
    0,
  )
  return totalBaseline * config.allocation.freeCreditRatio
}

/**
 * Grandfathering (per the notebook): each player's free credits for the target
 * year are proportional to their share of the class's total emissions over the
 * moving 10-year window. Realized years enter the window as the game advances.
 *
 * Unlike benchmarking and auctioning, the grandfathering cap does NOT tighten by
 * default — `allocation.applyLRFToGrandfathering` turns that on, which simulations
 * use to compare the three regimes on equal footing.
 */
export const grandfathering: CapMechanism = {
  mode: 'grandfathering',
  implemented: true,
  usesAuction: false,
  computeFreeCreditLimit,
  // Free allocation is the only issuance — there is no primary sale.
  poolFor() {
    return 0
  },
  /**
   * Nothing is sold to the class, but `regulatorGranted` still carries the opening book
   * bought by pure-trader bots (they get no free allocation and cannot short, so without
   * it a market maker has nothing to quote asks against). They pay the reference price
   * for it, exactly as they would pay the clearing price at an auction.
   */
  primaryPrice(_record, _config, reference) {
    return round1(reference)
  },
  allocate(players, targetYear, freeCreditLimit, config) {
    const sums = new Map(
      players.map((p) => [
        p.id,
        isPureTrader(p) ? 0 : windowSum(p, targetYear, config.emissions.historyWindow),
      ]),
    )
    const total = [...sums.values()].reduce((a, b) => a + b, 0)
    const { applyLRFToGrandfathering, capReductionFactor } = config.allocation
    const limit = applyLRFToGrandfathering
      ? freeCreditLimit *
        Math.pow(capReductionFactor, targetYear - config.emissions.firstGameYear)
      : freeCreditLimit
    const allocation: Record<string, number> = {}
    for (const player of players) {
      allocation[player.id] = total > 0 ? round1((sums.get(player.id)! / total) * limit) : 0
    }
    return allocation
  },
}

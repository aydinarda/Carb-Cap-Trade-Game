import type { GameConfig } from '../config/schema'
import type { Player } from '../types'
import type { CapMechanism } from './capMechanism'
import { round1 } from './rng'
import { isPureTrader } from './roles'
import { cumulativeCapFactor } from './capReduction'

/**
 * Benchmarking: every installation in a sector gets the same free allocation — the
 * sector benchmark — regardless of its own emission history. This is the textbook
 * contrast with grandfathering, which rewards your own past instead. The benchmark
 * opens near the sector average (BENCHMARK_STRINGENCY) and is tightened every year by the
 * cap reduction factor, so an average company
 * is structurally short and must either cut emissions or buy on the secondary
 * market; only a genuinely efficient one ends up long. As with the EU's annual
 * benchmark update, the allocation tightens each year by `capReductionFactor`.
 *
 * There is no primary sale: the free allocation is the only issuance, so the total
 * in circulation is fixed and the secondary market only redistributes it.
 */
export function benchmarkFor(player: Player, targetYear: number, config: GameConfig): number {
  // Pure-trader bots have no activity level to benchmark against — see roles.ts.
  if (isPureTrader(player)) return 0
  const reduction = cumulativeCapFactor(config, targetYear)
  return round1((config.allocation.benchmark[player.industry] ?? 0) * reduction)
}

export const benchmarking: CapMechanism = {
  mode: 'benchmarking',
  implemented: true,
  usesAuction: false,
  computeFreeCreditLimit(players, config) {
    // The class total in the first game year, matching when this is computed.
    return round1(
      players.reduce((sum, p) => sum + benchmarkFor(p, config.emissions.firstGameYear, config), 0),
    )
  },
  allocate(players, targetYear, _freeCreditLimit, config) {
    const allocation: Record<string, number> = {}
    for (const player of players) {
      allocation[player.id] = benchmarkFor(player, targetYear, config)
    }
    return allocation
  },
  poolFor() {
    return 0
  },
  // Charges the pure-trader bots for the opening book they are sold in openYear.
  // Everyone else has an empty `regulatorGranted`, so this costs them nothing.
  primaryPrice(_record, _config, reference) {
    return round1(reference)
  },
}


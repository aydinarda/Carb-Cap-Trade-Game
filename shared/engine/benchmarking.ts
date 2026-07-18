import type { CapMechanism } from './capMechanism'
import { round1 } from './rng'

/**
 * Benchmarking: every company in an industry gets the same flat free allocation,
 * `config.benchmark[industry]`, independent of its own emission history. This is
 * the textbook contrast with grandfathering (which rewards your own past). The
 * regulator then sells whatever slice of the baseline is left (Σbaseline − Σfree)
 * at the fixed price; a company still tops up / covers shortage in the market.
 */
export const benchmarking: CapMechanism = {
  mode: 'benchmarking',
  implemented: true,
  computeFreeCreditLimit(players, config) {
    return round1(players.reduce((sum, p) => sum + (config.benchmark[p.industry] ?? 0), 0))
  },
  allocate(players, _targetYear, _freeCreditLimit, config) {
    const allocation: Record<string, number> = {}
    for (const player of players) {
      allocation[player.id] = round1(config.benchmark[player.industry] ?? 0)
    }
    return allocation
  },
}

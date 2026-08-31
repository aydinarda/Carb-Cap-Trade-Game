import type { GameConfig } from '../config/schema'
import type { Player } from '../types'
import { benchmarkFor } from './benchmarking'
import { cumulativeCapFactor } from './capReduction'
import type { CapMechanism } from './capMechanism'
import { round1 } from './rng'

/**
 * Hybrid: part of the sector benchmark is issued free, and the REST OF THE CAP is auctioned.
 *
 * The two regimes it combines are each a half-truth about the EU ETS. Benchmarking hands
 * every installation its sector figure and never sells anything, so the class never has to
 * price scarcity at a primary market. Auctioning sells everything, so nobody ever argues
 * about who deserves a free allocation. The real scheme has done both at once since Phase 3:
 * power generation buys every allowance at auction, while sectors judged to be at risk of
 * carbon leakage keep receiving free allocation against a benchmark.
 *
 * `hybridFreeShare` is that political decision, made per sector by the instructor: 1 issues
 * the whole sector benchmark free, 0.5 half of it, 0 nothing at all.
 *
 * The teaching point is the SUBTRACTION. Free allocation is not additional supply — the cap
 * is fixed first, and everything given away is taken out of what the auction has left to
 * sell:
 *
 *   cap(y)  = auctionCapRatio × Σbaseline × cumulativeCapFactor(y)
 *   free(y) = Σ benchmarkFor(i, y) × hybridFreeShare[sector(i)]
 *   pool(y) = max(0, cap(y) − free(y))
 *
 * So a class that votes itself a generous free allocation discovers it has shrunk its own
 * auction, and the sectors paying for every tonne are paying for the exemption too. Total
 * issuance is `cap(y)` whatever the shares are, which is what keeps the environmental
 * outcome fixed while the distributional one moves — the distinction the mode exists to make.
 *
 * Everything else is inherited rather than restated: `benchmarkFor` already tightens by the
 * yearly reduction factor and already gives pure-trader bots nothing, and the clearing,
 * pricing and settlement of the auction are `auctioning`'s, reached through the same
 * `usesAuction` flag the session already branches on.
 */
export function hybridFreeFor(
  player: Player,
  targetYear: number,
  config: GameConfig,
): number {
  const share = config.allocation.hybridFreeShare[player.industry] ?? 0
  return round1(benchmarkFor(player, targetYear, config) * share)
}

/** The class's total free issuance for a year — the amount the auction pool loses. */
function totalFree(players: Player[], targetYear: number, config: GameConfig): number {
  return round1(players.reduce((sum, p) => sum + hybridFreeFor(p, targetYear, config), 0))
}

export const hybrid: CapMechanism = {
  mode: 'hybrid',
  implemented: true,
  usesAuction: true,
  freeAllocation: 'benchmark',
  computeFreeCreditLimit(players, config) {
    // The class total in the first game year, matching when this is computed. As under
    // benchmarking the figure is informational — `allocate` derives each company's number
    // from its own sector rather than dividing a class-wide limit.
    return totalFree(players, config.emissions.firstGameYear, config)
  },
  allocate(players, targetYear, _freeCreditLimit, config) {
    const allocation: Record<string, number> = {}
    for (const player of players) {
      allocation[player.id] = hybridFreeFor(player, targetYear, config)
    }
    return allocation
  },
  poolFor(players, targetYear, config, totalBaseline) {
    const cap =
      config.allocation.auctionCapRatio * totalBaseline * cumulativeCapFactor(config, targetYear)
    // Clamped, not allowed to go negative: shares generous enough to exhaust the cap leave
    // no auction rather than a negative supply, and the mode degenerates to benchmarking.
    // The host lobby warns when the numbers are heading there.
    return round1(Math.max(0, cap - totalFree(players, targetYear, config)))
  },
  // The auction is the primary sale, exactly as under auctioning: everything in
  // `regulatorGranted` was won there and is charged at the uniform clearing price. The free
  // allocation is not in `regulatorGranted` at all, so it stays free.
  primaryPrice(record) {
    return record.auctionPrice ?? 0
  },
}

import type { CapMechanism } from './capMechanism'
import { round1 } from './rng'
import { cumulativeCapFactor } from './capReduction'

/**
 * Auctioning: no free credits at all. The regulator puts a fixed supply — the cap —
 * on offer at a single-round sealed-bid uniform-price auction, and every company
 * buys its allowances there or in the secondary market afterwards. The supply
 * shrinks each year by `capReductionFactor`, the EU-ETS linear reduction factor.
 */
export const auctioning: CapMechanism = {
  mode: 'auctioning',
  implemented: true,
  usesAuction: true,
  freeAllocation: 'none',
  computeFreeCreditLimit() {
    return 0
  },
  allocate(players) {
    const allocation: Record<string, number> = {}
    for (const player of players) allocation[player.id] = 0
    return allocation
  },
  poolFor(_players, targetYear, config, totalBaseline) {
    const { auctionCapRatio } = config.allocation
    const reduction = cumulativeCapFactor(config, targetYear)
    return round1(auctionCapRatio * totalBaseline * reduction)
  },
  primaryPrice(record) {
    return record.auctionPrice ?? 0
  },
}

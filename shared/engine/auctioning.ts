import type { CapMechanism } from './capMechanism'

/**
 * Auctioning: no free credits. Every company buys all its allowances at the fixed
 * price. Since nothing is given for free, the regulator pool at the cap stage is
 * the full baseline (Σbaseline − Σfree = Σbaseline), sold pro-rata if the class
 * over-requests, and companies still top up in the fixed-price secondary market.
 */
export const auctioning: CapMechanism = {
  mode: 'auctioning',
  implemented: true,
  computeFreeCreditLimit() {
    return 0
  },
  allocate(players) {
    const allocation: Record<string, number> = {}
    for (const player of players) allocation[player.id] = 0
    return allocation
  },
}

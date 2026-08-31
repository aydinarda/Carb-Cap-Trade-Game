import type { GameConfig } from '../config/schema'
import type { CapMode, Player, YearRecord } from '../types'

/**
 * One cap-and-trade allocation regime. Everything mode-specific lives behind this
 * interface so the session never asks "is this auctioning?" — it asks the mechanism
 * what to do. A combined regime (e.g. benchmark free allocation plus an auction of
 * the residual cap) is therefore a new implementation of this interface and a
 * registry entry, with no changes to the session or the views.
 */
export interface CapMechanism {
  readonly mode: CapMode
  readonly implemented: boolean
  /** Does the cap stage run a sealed-bid primary auction? */
  readonly usesAuction: boolean
  /**
   * What the free allocation is derived from — the views ask this instead of the mode name.
   *
   * `'history'` is the company's own past emissions (grandfathering), `'benchmark'` a flat
   * sector figure it is measured against, `'none'` no free issuance at all. The player
   * snapshot sends the sector benchmark and its sector average whenever this is
   * `'benchmark'`, which is what lets a combined regime inherit that panel without
   * `views.ts` learning a fourth mode name.
   */
  readonly freeAllocation: 'none' | 'history' | 'benchmark'
  /** Total free credits available to the class, from the baseline year. */
  computeFreeCreditLimit(players: Player[], config: GameConfig): number
  /** Per-player free credit allocation for the target year. */
  allocate(
    players: Player[],
    targetYear: number,
    freeCreditLimit: number,
    config: GameConfig,
  ): Record<string, number>
  /** Primary-market supply for the target year; 0 = no primary sale. */
  poolFor(
    players: Player[],
    targetYear: number,
    config: GameConfig,
    totalBaseline: number,
  ): number
  /**
   * Unit price charged for the credits in `regulatorGranted`. `reference` is the
   * year's opening reference price (last discovered price, else half the penalty).
   */
  primaryPrice(record: YearRecord, config: GameConfig, reference: number): number
}

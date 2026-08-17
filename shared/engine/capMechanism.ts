import type { CapMode, Player, SessionConfig } from '../types'

export interface CapMechanism {
  readonly mode: CapMode
  readonly implemented: boolean
  /** Total free credits available to the class, from the baseline year. */
  computeFreeCreditLimit(players: Player[], config: SessionConfig): number
  /** Per-player free credit allocation for the target year. */
  allocate(
    players: Player[],
    targetYear: number,
    freeCreditLimit: number,
    config: SessionConfig,
  ): Record<string, number>
}

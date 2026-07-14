import type { CapMode, Player, SessionConfig } from '../types'

export class MechanismNotImplementedError extends Error {
  constructor(mode: CapMode) {
    super(`Cap mechanism "${mode}" is not implemented yet — details pending from the game designer.`)
    this.name = 'MechanismNotImplementedError'
  }
}

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

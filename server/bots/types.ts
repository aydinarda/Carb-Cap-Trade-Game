import type { Rng } from '../../shared/engine'
import type { BotType, Player } from '../../shared/types'
import type { Session } from '../session'

export type { BotType }

/** Ephemeral per-bot runtime, kept in the BotManager — never serialized into GameState. */
export interface BotRuntime {
  lastSeenPrice?: number
  /** Persistent personality price bias (drawn once from N(0, SIGMA[type])). */
  bias?: number
}

/** Everything an archetype's advance() needs. */
export interface BotCtx {
  session: Session
  bot: Player
  rng: Rng
  rt: BotRuntime
}

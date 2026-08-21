import type { Rng } from '../../shared/engine'
import type { BotType, MarketView, Player } from '../../shared/types'
import type { Session } from '../session'

export type { BotType }

/** Ephemeral per-bot runtime, kept in the BotManager — never serialized into GameState. */
export interface BotRuntime {
  lastSeenPrice?: number
  /** Persistent personality price bias (drawn once from N(0, SIGMA[type])). */
  bias?: number
  /**
   * The id of this bot's own resting quote on each side. A requote then replaces exactly
   * that order and leaves anything else the bot has resting — the unfilled remainder of a
   * marketable order, say — alone. Matching on price instead would cancel those too and
   * halve the depth the maker is there to provide.
   */
  quoteId?: Partial<Record<'buy' | 'sell', string>>
}

/** Everything an archetype's advance() needs. */
export interface BotCtx {
  session: Session
  bot: Player
  rng: Rng
  rt: BotRuntime
  /**
   * The order book as of the start of this tick, built ONCE by `stepBots` and shared by
   * every bot. Rebuilding it per bot made the tick quadratic in bot count: each view is
   * O(orders), and the order array itself grows with the number of bots, so 8× the bots
   * cost 31× the time. A bot that needs its own orders excluded (the market maker) derives
   * that itself — there are only one or two of those.
   */
  market: MarketView
}

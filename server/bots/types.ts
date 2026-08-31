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
  /**
   * The last year in which this bot made an install decision. Abatement capacity is
   * permanent and every step pays the retrofit fee again, so a bot that reconsidered on
   * every tick would buy a dozen slices a year and pay a dozen fees. One decision a year,
   * belt-and-braces with `setAbatement`'s own idempotence.
   */
  lastInvestYear?: number
  /**
   * Trade-stage ticks this bot has seen in the current year, and the year they belong to.
   *
   * Counted in ticks rather than as a fraction of the round because the engine does not know
   * how long a round will be — the instructor closes the market by hand, and the load test
   * sets its own window. Ticks are the only unit both the live game and the simulator share.
   */
  tradeTicks?: number
  tradeTicksYear?: number
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
  /**
   * True on a repeat call within the same tick — see `marketMaker.actionsPerTick`.
   *
   * Only the market maker is given extra passes, and only it reads this: anything counting
   * ticks to pace itself (its quiet window) must not advance on a repeat, or the pacing
   * would silently run `actionsPerTick` times faster than the number configuring it says.
   */
  extraPass?: boolean
}

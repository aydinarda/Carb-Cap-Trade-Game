import { buildMarketView, type Rng } from '../../shared/engine'
import { GameError, type Session } from '../session'
import * as compliance from './compliance'
import * as marketMaker from './marketMaker'
import * as noise from './noise'
import * as speculator from './speculator'
import type { BotCtx, BotRuntime, BotType } from './types'

const ARCHETYPES: Record<
  BotType,
  { trade: (c: BotCtx) => boolean; auction: (c: BotCtx) => boolean }
> = { compliance, marketMaker, speculator, noise }

/**
 * Advances every bot in a session by one tick, and reports whether any of them acted.
 *
 * Extracted from `BotManager` so the live interval driver and the headless simulator run
 * the *same* bot code — a simulation that exercised a copy would be measuring the copy.
 * `runtimeFor` supplies the caller's per-bot scratch state (personality bias, last seen
 * price), which is deliberately never serialized into `GameState`.
 */
export function stepBots(
  session: Session,
  rng: Rng,
  runtimeFor: (playerId: string) => BotRuntime,
): boolean {
  const phase = session.state.phase
  if (phase !== 'cap' && phase !== 'trade') return false
  // Under a free-allocation mode there is no primary auction to bid into, so the bots
  // only work the order book once the market opens.
  if (phase === 'cap' && !session.usesAuction) return false
  const record = session.currentYearRecord()
  if (!record) return false

  const bots = session.state.players.filter((p) => p.isBot && p.botType)
  if (bots.length === 0) return false

  // Built ONCE and shared. Each view is O(orders) and the order array grows with the bot
  // count, so rebuilding it per bot made the tick quadratic: 8× the bots cost 31× the time,
  // essentially all of it in this one call repeated N times.
  let market = buildMarketView(record.orders, record.trades)

  let acted = false
  for (const bot of bots) {
    // Cap stage: bid once (don't re-submit/re-broadcast every tick).
    if (phase === 'cap' && record.auctionBid[bot.id] !== undefined) continue
    const arch = ARCHETYPES[bot.botType as BotType]
    if (!arch) continue
    const rt = runtimeFor(bot.id)
    // Draw this bot's persistent personality bias once (type-specific dispersion).
    if (rt.bias === undefined) {
      rt.bias = rng.normal(0, session.state.config.bots.sigma[bot.botType as BotType])
    }
    const ctx: BotCtx = { session, bot, rng, rt, market }
    try {
      acted = (phase === 'cap' ? arch.auction : arch.trade)(ctx) || acted
    } catch (e) {
      // A GameError is a legitimate rejection (wrong phase, no shorting); anything else
      // is a bug worth surfacing, but must not take the whole tick down.
      if (!(e instanceof GameError)) console.error('[bot]', e)
    }
  }

  /**
   * Extra market-maker passes within this same tick.
   *
   * The maker is the only archetype with a two-sided obligation, and at one pass per tick it
   * was outnumbered by twenty compliance bots each working one side. Repeating its turn lets
   * it re-price both legs and take the fills that appeared during the pass just finished.
   *
   * The view is REBUILT between passes, which is the expensive thing this file otherwise
   * avoids — so it is bounded three ways: only makers repeat, only during the trade stage
   * (there is no book to re-read at an auction), and the loop stops the moment a whole pass
   * changes nothing, which is what a quiet market does immediately.
   */
  const passes = session.state.config.bots.marketMaker.actionsPerTick
  if (phase === 'trade' && passes > 1) {
    const makers = bots.filter((b) => b.botType === 'marketMaker')
    for (let pass = 1; pass < passes && makers.length > 0; pass++) {
      market = buildMarketView(record.orders, record.trades)
      let movedThisPass = false
      for (const bot of makers) {
        try {
          const ctx: BotCtx = {
            session, bot, rng, rt: runtimeFor(bot.id), market, extraPass: true,
          }
          movedThisPass = marketMaker.trade(ctx) || movedThisPass
        } catch (e) {
          if (!(e instanceof GameError)) console.error('[bot]', e)
        }
      }
      if (!movedThisPass) break
      acted = true
    }
  }
  return acted
}

import type { Server } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/events'
import { createRng, type Rng } from '../../shared/engine'
import { GameError, type Session, type SessionStore } from '../session'
import * as compliance from './compliance'
import * as marketMaker from './marketMaker'
import * as noise from './noise'
import * as speculator from './speculator'
import { BOT_TICK_MS, SIGMA, type BotCtx, type BotRuntime, type BotType } from './types'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type Broadcast = (io: IO, session: Session) => void | Promise<void>

const ARCHETYPES: Record<
  BotType,
  { trade: (c: BotCtx) => boolean; auction: (c: BotCtx) => boolean }
> = { compliance, marketMaker, speculator, noise }

/**
 * Drives all backend bots. A single ~2.5s interval scans every live session and lets
 * each bot act once per tick (auction bid in 'cap', an order-book move in 'trade').
 * Modes without a primary auction skip the cap stage entirely. Broadcasts only when
 * a bot actually did something. Uses its own RNG per session so bot randomness never
 * perturbs the engine's seeded emission realizations.
 */
export class BotManager {
  private timer?: NodeJS.Timeout
  private rngs = new Map<string, Rng>()
  private runtime = new Map<string, BotRuntime>()

  constructor(
    private io: IO,
    private store: SessionStore,
    private broadcast: Broadcast,
  ) {}

  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), BOT_TICK_MS)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private rngFor(session: Session): Rng {
    let r = this.rngs.get(session.state.roomCode)
    if (!r) {
      r = createRng((session.state.seed ^ 0xb07) >>> 0)
      this.rngs.set(session.state.roomCode, r)
    }
    return r
  }

  private rtFor(room: string, playerId: string): BotRuntime {
    const key = `${room}:${playerId}`
    let rt = this.runtime.get(key)
    if (!rt) {
      rt = {}
      this.runtime.set(key, rt)
    }
    return rt
  }

  private tick() {
    for (const session of this.store.activeSessions()) {
      const phase = session.state.phase
      if (phase !== 'cap' && phase !== 'trade') continue
      // Under a free-allocation mode there is no primary auction to bid into, so the
      // bots only work the order book once the market opens.
      if (phase === 'cap' && !session.usesAuction) continue
      const record = session.currentYearRecord()
      if (!record) continue
      const bots = session.state.players.filter((p) => p.isBot && p.botType)
      if (bots.length === 0) continue

      const rng = this.rngFor(session)
      let acted = false
      for (const bot of bots) {
        // Cap stage: bid once (don't re-submit/re-broadcast every tick).
        if (phase === 'cap' && record.auctionBid[bot.id] !== undefined) continue
        const arch = ARCHETYPES[bot.botType as BotType]
        if (!arch) continue
        const rt = this.rtFor(session.state.roomCode, bot.id)
        // Draw this bot's persistent personality bias once (type-specific dispersion).
        if (rt.bias === undefined) rt.bias = rng.normal(0, SIGMA[bot.botType as BotType])
        const ctx: BotCtx = { session, bot, rng, rt }
        try {
          acted = (phase === 'cap' ? arch.auction : arch.trade)(ctx) || acted
        } catch (e) {
          if (!(e instanceof GameError)) console.error('[bot]', e)
        }
      }
      if (acted) void this.broadcast(this.io, session)
    }
  }
}

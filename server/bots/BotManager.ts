import type { Server } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/events'
import { createRng, type Rng } from '../../shared/engine'
import { BOT_TICK_MS } from '../config'
import type { Session, SessionStore } from '../session'
import { stepBots } from './step'
import type { BotRuntime } from './types'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type Broadcast = (io: IO, session: Session) => void | Promise<void>

/**
 * Drives all backend bots. A single interval scans every live session and lets each bot
 * act once per tick via `stepBots` — the same function the headless simulator calls.
 * Broadcasts only when a bot actually did something. Uses its own RNG per session so bot
 * randomness never perturbs the engine's seeded emission realizations.
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
      const acted = stepBots(session, this.rngFor(session), (playerId) =>
        this.rtFor(session.state.roomCode, playerId),
      )
      if (acted) void this.broadcast(this.io, session)
    }
  }
}

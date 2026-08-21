import type { Server } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/events'
import { createRng, type Rng } from '../../shared/engine'
import { BOT_TICK_MS } from '../config'
import type { Session, SessionStore } from '../session'
import { stepBots } from './step'
import type { BotRuntime } from './types'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type Broadcast = (io: IO, session: Session) => void | Promise<void>

/** Sweep for dead rooms every N ticks — cheap, but no reason to do it 24×/min. */
const SWEEP_EVERY_TICKS = 60

/**
 * Drives all backend bots. A single interval walks the rooms worth ticking and lets each
 * bot act once per tick via `stepBots` — the same function the headless simulator calls.
 * Broadcasts only when a bot actually changed something. Uses its own RNG per session so
 * bot randomness never perturbs the engine's seeded emission realizations, and periodically
 * drops rooms that have finished or been abandoned.
 */
export class BotManager {
  private timer?: NodeJS.Timeout
  private rngs = new Map<string, Rng>()
  private runtime = new Map<string, BotRuntime>()
  private ticks = 0

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
    if (++this.ticks % SWEEP_EVERY_TICKS === 0) this.sweep()
  }

  /** Drop dead rooms and the per-room state this manager keeps for them. */
  private sweep() {
    for (const code of this.store.sweep()) {
      this.rngs.delete(code)
      // Runtime is keyed `room:playerId`, so the room's entries go with it — otherwise
      // the leak would simply move from the store into here.
      const prefix = `${code}:`
      for (const key of this.runtime.keys()) {
        if (key.startsWith(prefix)) this.runtime.delete(key)
      }
    }
  }
}

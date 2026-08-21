import type { Server, Socket } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/events'
import { FLUSH_MS } from './config'
import type { Session } from './session'
import { hostSnapshot, playerSnapshot } from './views'

export type IO = Server<ClientToServerEvents, ServerToClientEvents>

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents> & {
  data: { role?: 'player' | 'host'; roomCode?: string; playerId?: string }
}

/** Membership room. Kept for `io.socketsLeave` and as a stable socket.io-side grouping. */
export function roomAll(code: string) {
  return `${code}:all`
}

/**
 * Owns *when* and *to whom* session state is pushed.
 *
 * Two problems this exists to solve, both measured at 100 players:
 *
 * 1. **Fan-out cost.** Every mutation used to push a freshly built snapshot to every socket
 *    individually — 2.6 MB of `JSON.stringify` per broadcast, on the same event loop that
 *    answers Render's health check. The host snapshot is now built *once* per flush instead
 *    of once per host socket, which is the first slice of that back.
 * 2. **Fan-out frequency.** Every player action broadcast inline, so a burst of orders cost
 *    one full fan-out each. Mutations now `schedule()` a coalesced flush.
 *
 * Deliberately owned by the socket layer rather than by `Session`/`SessionStore`: both of
 * those are socket-free by design (`sim/` drives `Session` directly, in-process), and that
 * is worth preserving.
 *
 * **Single-process assumption.** `members` is a local registry rather than a round-trip
 * through `io.in(room).fetchSockets()`. That is exactly equivalent under the default
 * in-memory adapter and lets `flush()` be synchronous, which is what guarantees emit
 * ordering. Scaling to more than one Node process would need a Redis adapter *and* a
 * replacement for this registry — but `SessionStore` is in-memory too, so that is already
 * impossible today.
 */
export class Broadcaster {
  private timers = new Map<string, NodeJS.Timeout>()
  private members = new Map<string, Set<AppSocket>>()

  constructor(private io: IO) {}

  /** Register a socket as a recipient for its room. */
  join(socket: AppSocket, session: Session) {
    const code = session.state.roomCode
    void socket.join(roomAll(code))
    let set = this.members.get(code)
    if (!set) {
      set = new Set()
      this.members.set(code, set)
    }
    set.add(socket)
  }

  /** Drop a socket from its room's registry. Safe to call for sockets that never joined. */
  leave(socket: AppSocket) {
    const code = socket.data.roomCode
    if (!code) return
    const set = this.members.get(code)
    if (!set) return
    set.delete(socket)
    if (set.size === 0) this.members.delete(code)
  }

  /**
   * Coalesced push. Trailing-edge: at most one flush per FLUSH_MS per room, and the last
   * state is never dropped — the timer is always armed *after* the mutation, and `flush()`
   * reads live session state at fire time. Acks are already sent before this is called, so
   * only the state echo waits.
   */
  schedule(session: Session) {
    session.touch()
    const code = session.state.roomCode
    if (this.timers.has(code)) return // a trailing flush is already pending
    this.timers.set(
      code,
      setTimeout(() => {
        this.timers.delete(code)
        this.flush(session)
      }, FLUSH_MS),
    )
  }

  /**
   * Immediate push, cancelling any pending flush. For phase transitions: they are rare
   * (a handful per year), the instructor is driving them off a projector, and "Open the
   * market" is the one place a 100 ms lag would be noticed.
   */
  flushNow(session: Session) {
    session.touch()
    const timer = this.timers.get(session.state.roomCode)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(session.state.roomCode)
    }
    this.flush(session)
  }

  /**
   * Full state to a single socket, bypassing the coalescer. For join, reconnect and
   * session creation — a student must not wait out the flush window for their first state,
   * and one arrival must not cost the room a full fan-out.
   */
  sync(socket: AppSocket, session: Session) {
    session.touch()
    this.emitTo(socket, session, socket.data.role === 'host' ? hostSnapshot(session) : undefined)
  }

  /** Drop timers and the member registry for a swept room. */
  forget(code: string) {
    const timer = this.timers.get(code)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(code)
    }
    this.members.delete(code)
  }

  private flush(session: Session) {
    const set = this.members.get(session.state.roomCode)
    if (!set || set.size === 0) return

    // Built once for the whole flush rather than once per host socket: two instructor tabs
    // used to double the most expensive payload in the game.
    let host: ReturnType<typeof hostSnapshot> | undefined
    for (const socket of set) {
      if (socket.data.role === 'host' && !host) host = hostSnapshot(session)
      this.emitTo(socket, session, host)
    }
  }

  private emitTo(
    socket: AppSocket,
    session: Session,
    host: ReturnType<typeof hostSnapshot> | undefined,
  ) {
    if (socket.data.role === 'host') {
      socket.emit('session:snapshot', host ?? hostSnapshot(session))
    } else if (socket.data.playerId && session.getPlayer(socket.data.playerId)) {
      socket.emit('session:snapshot', playerSnapshot(session, socket.data.playerId))
    }
    // A kicked player keeps a socket whose playerId no longer resolves. Sending nothing is
    // the established behaviour — do not "fix" this into a throw.
  }
}

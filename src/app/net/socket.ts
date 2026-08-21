import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents, SocketAuth } from '@shared/events'

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export interface StoredIdentity {
  role: 'player' | 'host'
  roomCode: string
  token: string
  playerId?: string
}

const STORAGE_KEY = 'capgame:identity'

export function loadIdentity(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredIdentity) : null
  } catch {
    return null
  }
}

export function saveIdentity(identity: StoredIdentity) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
}

export function clearIdentity() {
  localStorage.removeItem(STORAGE_KEY)
}

let socket: AppSocket | null = null

/**
 * Backend origin. Empty in dev (Vite proxies /socket.io to :3001) and in the
 * single-service deploy where the server also serves this bundle. Set
 * VITE_SERVER_URL to the backend URL when frontend and backend are deployed
 * as separate services.
 */
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? ''

/** Set once if the WebSocket handshake fails, so a refresh does not repeat the failure. */
const FALLBACK_KEY = 'capgame:transport-fallback'

function initialTransports(): ('websocket' | 'polling')[] {
  try {
    return sessionStorage.getItem(FALLBACK_KEY) ? ['websocket', 'polling'] : ['websocket']
  } catch {
    return ['websocket']
  }
}

/**
 * Re-read on every connection attempt rather than captured once.
 *
 * The bug this fixes: a student who lands on the join screen constructs the socket with an
 * empty auth, and `joinAsPlayer` then writes their token to localStorage — but the live
 * socket still held the empty object. One Wi-Fi blip later it reconnected anonymously, the
 * server restored no identity, no snapshot ever arrived, and the resume watchdog dumped
 * them back to the join screen mid-round.
 */
function buildAuth(): SocketAuth {
  const identity = loadIdentity()
  return identity
    ? { role: identity.role, roomCode: identity.roomCode, token: identity.token }
    : {}
}

export function getSocket(): AppSocket {
  if (!socket) {
    // WebSocket only: the default is an HTTP long-polling handshake that then upgrades,
    // which costs three needless HTTP requests per connection and doubles the visible
    // request count on the backend.
    const opts = { auth: (cb: (d: object) => void) => cb(buildAuth()), transports: initialTransports() }
    const s: AppSocket = SERVER_URL ? io(SERVER_URL, opts) : io(opts)
    socket = s

    // Safety net for a network that blocks WebSocket outright (some school proxies do).
    // Mutating the manager's options rather than rebuilding the socket keeps every
    // listener GameContext has already registered.
    let downgraded = false
    s.on('connect_error', () => {
      if (downgraded || s.connected) return
      downgraded = true
      try {
        sessionStorage.setItem(FALLBACK_KEY, '1')
      } catch {
        /* private mode — the downgrade still applies for this page load */
      }
      s.io.opts.transports = ['websocket', 'polling']
    })
  }
  return socket
}

/** Reconnect with fresh auth after the stored identity changes (login/logout). */
export function resetSocket(): AppSocket {
  socket?.disconnect()
  socket = null
  return getSocket()
}

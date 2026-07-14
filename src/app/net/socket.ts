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

export function getSocket(): AppSocket {
  if (!socket) {
    const identity = loadIdentity()
    const auth: SocketAuth = identity
      ? { role: identity.role, roomCode: identity.roomCode, token: identity.token }
      : {}
    socket = SERVER_URL ? io(SERVER_URL, { auth }) : io({ auth })
  }
  return socket
}

/** Reconnect with fresh auth after the stored identity changes (login/logout). */
export function resetSocket(): AppSocket {
  socket?.disconnect()
  socket = null
  return getSocket()
}

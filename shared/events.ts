import type { Industry } from './constants'
import type { CapMode, OrderSide, Phase, PlayerProfile, Snapshot } from './types'

export type Ack<T = unknown> = (
  response: ({ ok: true } & T) | { ok: false; error: string },
) => void

export interface ClientToServerEvents {
  'host:createSession': (
    payload: { hostKey: string; capMode: CapMode; seed?: number },
    ack: Ack<{ roomCode: string; hostToken: string }>,
  ) => void
  /** Allowed in lobby and yearSummary — the new mode applies from the next year. */
  'host:setCapMode': (payload: { mode: CapMode }, ack: Ack) => void
  'host:updateSettings': (
    payload: { regulatorPrice?: number; lowPenaltyRate?: number; highPenaltyRate?: number },
    ack: Ack,
  ) => void
  'host:startYear': (payload: Record<string, never>, ack: Ack) => void
  'host:closeCapStage': (payload: Record<string, never>, ack: Ack) => void
  'host:openTrade': (payload: Record<string, never>, ack: Ack) => void
  'host:closeTrade': (payload: Record<string, never>, ack: Ack) => void
  'host:advanceYear': (payload: Record<string, never>, ack: Ack) => void
  'host:endGame': (payload: Record<string, never>, ack: Ack) => void
  'host:kickPlayer': (payload: { playerId: string }, ack: Ack) => void
  'player:join': (
    payload: { roomCode: string; name: string; industry: Industry },
    ack: Ack<{ playerId: string; token: string; profile: PlayerProfile }>,
  ) => void
  /** Cap stage: how many credits to request from the regulator pool. */
  'player:requestCredits': (payload: { qty: number }, ack: Ack) => void
  /** Trade stage: place a limit order in the student market. */
  'player:placeOrder': (payload: { side: OrderSide; qty: number; price: number }, ack: Ack) => void
  'player:cancelOrder': (payload: { orderId: string }, ack: Ack) => void
}

export interface ServerToClientEvents {
  'session:snapshot': (snapshot: Snapshot) => void
  'phase:changed': (payload: { phase: Phase; year: number }) => void
  'session:error': (payload: { code: string; message: string }) => void
}

/** Sent by the client in the Socket.IO handshake `auth` field. */
export interface SocketAuth {
  role?: 'player' | 'host'
  roomCode?: string
  token?: string
}

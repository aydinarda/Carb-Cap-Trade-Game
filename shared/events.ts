import type { Industry } from './constants'
import type { BotType, CapMode, OrderSide, Phase, PlayerProfile, Snapshot } from './types'

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
    payload: {
      penaltyRate?: number
      benchmark?: Partial<Record<Industry, number>>
      abatement?: Partial<Record<Industry, { a: number; b: number }>>
      auctionCapRatio?: number
    },
    ack: Ack,
  ) => void
  'host:startYear': (payload: Record<string, never>, ack: Ack) => void
  'host:closeCapStage': (payload: Record<string, never>, ack: Ack) => void
  'host:openTrade': (payload: Record<string, never>, ack: Ack) => void
  'host:closeTrade': (payload: Record<string, never>, ack: Ack) => void
  'host:advanceYear': (payload: Record<string, never>, ack: Ack) => void
  'host:endGame': (payload: Record<string, never>, ack: Ack) => void
  'host:kickPlayer': (payload: { playerId: string }, ack: Ack) => void
  /** Lobby only: add N backend bots of one archetype (auctioning mode). */
  'host:addBots': (payload: { botType: BotType; count: number }, ack: Ack) => void
  /** Lobby only: remove one bot by id. */
  'host:removeBot': (payload: { playerId: string }, ack: Ack) => void
  'player:join': (
    payload: { roomCode: string; name: string; industry: Industry },
    ack: Ack<{ playerId: string; token: string; profile: PlayerProfile }>,
  ) => void
  /** Cap stage (auctioning): sealed bid — quantity and max price per credit. */
  'player:submitBid': (payload: { qty: number; price: number }, ack: Ack) => void
  /** Trade stage: place a limit order (bid/ask) in the order book. */
  'player:placeOrder': (payload: { side: OrderSide; qty: number; price: number }, ack: Ack) => void
  /** Trade stage: cancel one of your resting orders. */
  'player:cancelOrder': (payload: { orderId: string }, ack: Ack) => void
  /** Trade stage: invest to cut emissions by a fraction (0..1) of the expected. */
  'player:abate': (payload: { fraction: number }, ack: Ack) => void
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

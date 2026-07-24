import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import type { Industry } from '@shared/constants'
import type { CapMode, HostSnapshot, PlayerSnapshot, Snapshot } from '@shared/types'
import {
  clearIdentity,
  getSocket,
  loadIdentity,
  resetSocket,
  saveIdentity,
  type AppSocket,
} from './socket'

type AckResponse = { ok: true } & Record<string, unknown>

function request<E extends string>(
  socket: AppSocket,
  event: E,
  payload: unknown,
): Promise<AckResponse> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(socket as any).emit(event, payload, (response: { ok: boolean; error?: string }) => {
      if (response.ok) resolve(response as AckResponse)
      else reject(new Error(response.error ?? 'Unknown error'))
    })
  })
}

interface GameContextValue {
  connected: boolean
  /** True while we hold a stored identity but haven't received a snapshot yet. */
  resuming: boolean
  snapshot: Snapshot | null
  playerSnapshot: PlayerSnapshot | null
  hostSnapshot: HostSnapshot | null
  joinAsPlayer: (roomCode: string, name: string, industry: Industry) => Promise<void>
  createSession: (hostKey: string, capMode: CapMode) => Promise<void>
  hostAction: (
    event:
      | 'host:setCapMode'
      | 'host:updateSettings'
      | 'host:startYear'
      | 'host:closeCapStage'
      | 'host:openTrade'
      | 'host:closeTrade'
      | 'host:advanceYear'
      | 'host:endGame'
      | 'host:kickPlayer',
    payload?: Record<string, unknown>,
  ) => Promise<boolean>
  requestCredits: (qty: number) => Promise<boolean>
  buyCredits: (qty: number) => Promise<boolean>
  sellCredits: (qty: number) => Promise<boolean>
  abate: (fraction: number) => Promise<boolean>
  leave: () => void
}

const GameContext = createContext<GameContextValue | null>(null)

export function GameProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [hasIdentity, setHasIdentity] = useState(() => loadIdentity() !== null)

  useEffect(() => {
    const socket = getSocket()
    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    const onSnapshot = (snap: Snapshot) => setSnapshot(snap)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('session:snapshot', onSnapshot)
    setConnected(socket.connected)
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('session:snapshot', onSnapshot)
    }
  }, [])

  // A stored identity whose session is gone (e.g. server restarted) never
  // receives a snapshot — fall back to a fresh join instead of hanging.
  useEffect(() => {
    if (!connected || !hasIdentity || snapshot !== null) return
    const timer = setTimeout(() => {
      clearIdentity()
      setHasIdentity(false)
      toast.info('Your previous session is no longer available.')
    }, 4000)
    return () => clearTimeout(timer)
  }, [connected, hasIdentity, snapshot])

  const value = useMemo<GameContextValue>(() => {
    const joinAsPlayer = async (roomCode: string, name: string, industry: Industry) => {
      const socket = getSocket()
      const res = await request(socket, 'player:join', {
        roomCode: roomCode.trim().toUpperCase(),
        name,
        industry,
      })
      saveIdentity({
        role: 'player',
        roomCode: roomCode.trim().toUpperCase(),
        token: res.token as string,
        playerId: res.playerId as string,
      })
      setHasIdentity(true)
    }

    const createSession = async (hostKey: string, capMode: CapMode) => {
      const socket = getSocket()
      const res = await request(socket, 'host:createSession', { hostKey, capMode })
      saveIdentity({
        role: 'host',
        roomCode: res.roomCode as string,
        token: res.hostToken as string,
      })
      setHasIdentity(true)
    }

    const hostAction: GameContextValue['hostAction'] = async (event, payload = {}) => {
      try {
        await request(getSocket(), event, payload)
        return true
      } catch (error) {
        toast.error((error as Error).message)
        return false
      }
    }

    const playerRequest = async (event: string, payload: Record<string, unknown>) => {
      try {
        await request(getSocket(), event, payload)
        return true
      } catch (error) {
        toast.error((error as Error).message)
        return false
      }
    }

    const requestCredits = (qty: number) => playerRequest('player:requestCredits', { qty })
    const buyCredits = (qty: number) => playerRequest('player:buyCredits', { qty })
    const sellCredits = (qty: number) => playerRequest('player:sellCredits', { qty })
    const abate = (fraction: number) => playerRequest('player:abate', { fraction })

    const leave = () => {
      clearIdentity()
      setSnapshot(null)
      setHasIdentity(false)
      resetSocket()
    }

    return {
      connected,
      resuming: hasIdentity && snapshot === null,
      snapshot,
      playerSnapshot: snapshot?.role === 'player' ? snapshot : null,
      hostSnapshot: snapshot?.role === 'host' ? snapshot : null,
      joinAsPlayer,
      createSession,
      hostAction,
      requestCredits,
      buyCredits,
      sellCredits,
      abate,
      leave,
    }
  }, [connected, snapshot, hasIdentity])

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext)
  if (!ctx) throw new Error('useGame must be used inside GameProvider')
  return ctx
}

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
import type { CapMode, HostSnapshot, OrderSide, PlayerSnapshot, Snapshot } from '@shared/types'
import {
  clearIdentity,
  getSocket,
  loadIdentity,
  resetSocket,
  saveIdentity,
  watchTarget,
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
      | 'host:announceSubsidy'
      | 'host:announceTech'
      | 'host:announceEnergyCrisis'
      | 'host:announceRateCut'
      | 'host:startYear'
      | 'host:closeCapStage'
      | 'host:openTrade'
      | 'host:closeTrade'
      | 'host:advanceYear'
      | 'host:endGame'
      | 'host:kickPlayer'
      | 'host:screeningPenalize'
      | 'host:screeningClear'
      | 'host:addBots'
      | 'host:removeBot'
      | 'host:addAgents',
    payload?: Record<string, unknown>,
  ) => Promise<boolean>
  submitBid: (qty: number, price: number) => Promise<boolean>
  /** A sweep: several (quantity, max price) steps, cleared by the same uniform-price auction. */
  submitSweep: (steps: { qty: number; price: number }[]) => Promise<boolean>
  /** Select or clear "cover a shortfall from next year's share" for this year. */
  setBorrow: (on: boolean) => Promise<boolean>
  placeOrder: (side: OrderSide, qty: number, price: number) => Promise<boolean>
  cancelOrder: (orderId: string) => Promise<boolean>
  abate: (fraction: number) => Promise<boolean>
  leave: () => void
  /** The company being watched on the read-only watch page; null when playing or hosting. */
  watching: string | null
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
  const watching = watchTarget()

  useEffect(() => {
    // Never on the watch page: the identity there is the host tab's, and clearing it would log
    // the host out of the game it is running.
    if (watching || !connected || !hasIdentity || snapshot !== null) return
    const timer = setTimeout(() => {
      clearIdentity()
      setHasIdentity(false)
      toast.info('Your previous session is no longer available.')
    }, 4000)
    return () => clearTimeout(timer)
  }, [connected, hasIdentity, snapshot, watching])

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

    const submitBid = (qty: number, price: number) =>
      playerRequest('player:submitBid', { qty, price })
    const submitSweep = (steps: { qty: number; price: number }[]) =>
      playerRequest('player:submitBid', { steps })
    const setBorrow = (on: boolean) => playerRequest('player:setBorrow', { on })
    const placeOrder = (side: OrderSide, qty: number, price: number) =>
      playerRequest('player:placeOrder', { side, qty, price })
    const cancelOrder = (orderId: string) => playerRequest('player:cancelOrder', { orderId })
    const abate = (fraction: number) => playerRequest('player:abate', { fraction })

    const leave = () => {
      clearIdentity()
      setSnapshot(null)
      setHasIdentity(false)
      resetSocket()
    }

    if (watching) {
      // Read only: nothing on this page acts, and nothing touches the stored host identity.
      const readOnly = async () => {
        toast.info('Read only — you are watching this company')
        return false
      }
      const refuse = async () => {
        throw new Error('Read only — you are watching this company')
      }
      return {
        connected,
        resuming: snapshot === null,
        snapshot,
        playerSnapshot: snapshot?.role === 'player' ? snapshot : null,
        hostSnapshot: null,
        joinAsPlayer: refuse,
        createSession: refuse,
        hostAction: readOnly,
        submitBid: readOnly,
        submitSweep: readOnly,
        setBorrow: readOnly,
        placeOrder: readOnly,
        cancelOrder: readOnly,
        abate: readOnly,
        leave: () => window.close(),
        watching,
      }
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
      submitBid,
      submitSweep,
      setBorrow,
      placeOrder,
      cancelOrder,
      abate,
      leave,
      watching: null,
    }
  }, [connected, snapshot, hasIdentity, watching])

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext)
  if (!ctx) throw new Error('useGame must be used inside GameProvider')
  return ctx
}

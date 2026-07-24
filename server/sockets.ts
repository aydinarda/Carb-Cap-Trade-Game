import type { Server, Socket } from 'socket.io'
import type { Ack, ClientToServerEvents, ServerToClientEvents, SocketAuth } from '../shared/events'
import { HOST_KEY, SEED } from './config'
import { GameError, Session, SessionStore } from './session'
import { hostSnapshot, playerSnapshot } from './views'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents> & {
  data: { role?: 'player' | 'host'; roomCode?: string; playerId?: string }
}

export const store = new SessionStore()

function roomAll(code: string) {
  return `${code}:all`
}

/** Push role-scoped snapshots to every connected socket of a session. */
async function broadcast(io: IO, session: Session) {
  const sockets = (await io.in(roomAll(session.state.roomCode)).fetchSockets()) as unknown as AppSocket[]
  for (const socket of sockets) {
    emitSnapshot(socket, session)
  }
}

function emitSnapshot(socket: AppSocket, session: Session) {
  if (socket.data.role === 'host') {
    socket.emit('session:snapshot', hostSnapshot(session))
  } else if (socket.data.playerId && session.getPlayer(socket.data.playerId)) {
    socket.emit('session:snapshot', playerSnapshot(session, socket.data.playerId))
  }
}

function fail(ack: Ack<never>, error: unknown) {
  if (error instanceof GameError) {
    ack({ ok: false, error: error.message })
  } else {
    console.error(error)
    ack({ ok: false, error: 'Unexpected server error.' })
  }
}

/** Wraps a host action: validates the socket is this session's host, runs, broadcasts. */
function hostAction(io: IO, socket: AppSocket, ack: Ack, action: (session: Session) => void) {
  try {
    const session = socket.data.role === 'host' && socket.data.roomCode
      ? store.get(socket.data.roomCode)
      : undefined
    if (!session) throw new GameError('NOT_HOST', 'Not authorized as host.')
    action(session)
    ack({ ok: true })
    void broadcast(io, session)
  } catch (error) {
    fail(ack, error)
  }
}

export function registerSockets(io: IO) {
  io.use((socket, next) => {
    // Reconnect path: map handshake token back to an identity
    const auth = socket.handshake.auth as SocketAuth
    const appSocket = socket as AppSocket
    if (auth?.token) {
      if (auth.role === 'host') {
        const session = store.findByHostToken(auth.token)
        if (session) {
          appSocket.data.role = 'host'
          appSocket.data.roomCode = session.state.roomCode
        }
      } else {
        const found = store.findByPlayerToken(auth.token)
        if (found) {
          appSocket.data.role = 'player'
          appSocket.data.roomCode = found.session.state.roomCode
          appSocket.data.playerId = found.playerId
        }
      }
    }
    next()
  })

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AppSocket

    // Resumed identity: rejoin room, flip connected, resend state
    if (socket.data.roomCode) {
      const session = store.get(socket.data.roomCode)
      if (session) {
        void socket.join(roomAll(session.state.roomCode))
        if (socket.data.playerId) {
          const player = session.getPlayer(socket.data.playerId)
          if (player) player.connected = true
        }
        void broadcast(io, session)
      }
    }

    socket.on('host:createSession', ({ hostKey, capMode, seed }, ack) => {
      try {
        if (hostKey !== HOST_KEY) throw new GameError('BAD_KEY', 'Wrong host key.')
        const session = store.create(capMode, seed ?? SEED)
        socket.data.role = 'host'
        socket.data.roomCode = session.state.roomCode
        void socket.join(roomAll(session.state.roomCode))
        ack({ ok: true, roomCode: session.state.roomCode, hostToken: session.hostToken })
        emitSnapshot(socket, session)
      } catch (error) {
        fail(ack, error)
      }
    })

    socket.on('host:setCapMode', ({ mode }, ack) =>
      hostAction(io, socket, ack, (s) => s.setCapMode(mode)))
    socket.on('host:updateSettings', (settings, ack) =>
      hostAction(io, socket, ack, (s) => s.updateSettings(settings)))
    socket.on('host:startYear', (_p, ack) =>
      hostAction(io, socket, ack, (s) => s.startYear()))
    socket.on('host:closeCapStage', (_p, ack) =>
      hostAction(io, socket, ack, (s) => s.closeCapStage()))
    socket.on('host:openTrade', (_p, ack) =>
      hostAction(io, socket, ack, (s) => s.openTrade()))
    socket.on('host:closeTrade', (_p, ack) =>
      hostAction(io, socket, ack, (s) => s.closeTrade()))
    socket.on('host:advanceYear', (_p, ack) =>
      hostAction(io, socket, ack, (s) => s.advanceYear()))
    socket.on('host:endGame', (_p, ack) =>
      hostAction(io, socket, ack, (s) => s.endGame()))
    socket.on('host:kickPlayer', ({ playerId }, ack) =>
      hostAction(io, socket, ack, (s) => s.kickPlayer(playerId)))

    socket.on('player:join', ({ roomCode, name, industry }, ack) => {
      try {
        const session = store.get(roomCode ?? '')
        if (!session) throw new GameError('NO_ROOM', 'Room not found. Check the code.')
        const { player, token } = session.addPlayer(name ?? '', industry)
        socket.data.role = 'player'
        socket.data.roomCode = session.state.roomCode
        socket.data.playerId = player.id
        void socket.join(roomAll(session.state.roomCode))
        ack({
          ok: true,
          playerId: player.id,
          token,
          profile: { industry: player.industry, emissions: player.emissions },
        })
        void broadcast(io, session)
      } catch (error) {
        fail(ack, error)
      }
    })

    const playerAction = (
      ack: Ack,
      action: (session: Session, playerId: string) => void,
    ) => {
      try {
        const session = socket.data.roomCode ? store.get(socket.data.roomCode) : undefined
        if (!session || !socket.data.playerId) {
          throw new GameError('NOT_JOINED', 'You are not in a session.')
        }
        action(session, socket.data.playerId)
        ack({ ok: true })
        void broadcast(io, session)
      } catch (error) {
        fail(ack, error)
      }
    }

    socket.on('player:requestCredits', ({ qty }, ack) =>
      playerAction(ack, (s, pid) => s.requestCredits(pid, Number(qty))))
    socket.on('player:buyCredits', ({ qty }, ack) =>
      playerAction(ack, (s, pid) => s.buyCredits(pid, Number(qty))))
    socket.on('player:sellCredits', ({ qty }, ack) =>
      playerAction(ack, (s, pid) => s.sellCredits(pid, Number(qty))))
    socket.on('player:abate', ({ fraction }, ack) =>
      playerAction(ack, (s, pid) => s.setAbatement(pid, Number(fraction))))

    socket.on('disconnect', () => {
      if (!socket.data.roomCode || !socket.data.playerId) return
      const session = store.get(socket.data.roomCode)
      const player = session?.getPlayer(socket.data.playerId)
      if (session && player) {
        player.connected = false
        void broadcast(io, session)
      }
    })
  })
}

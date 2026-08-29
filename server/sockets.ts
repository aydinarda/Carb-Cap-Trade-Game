import type { Ack, SocketAuth } from '../shared/events'
import { Broadcaster, type AppSocket, type IO } from './broadcaster'
import { HOST_KEY, SEED } from './config'
import { GameError, Session, SessionStore } from './session'

export const store = new SessionStore()

function fail(ack: Ack<never>, error: unknown) {
  if (error instanceof GameError) {
    // The CODE travels with the message. A caller that needs to tell an expected refusal
    // (no shorting, retrofits are permanent) from a real fault could otherwise only pattern
    // match on English prose — which silently reclassifies every rejection the moment
    // somebody rewords an error string.
    ack({ ok: false, error: error.message, code: error.code })
  } else {
    console.error(error)
    ack({ ok: false, error: 'Unexpected server error.' })
  }
}

/**
 * Wraps a host action: validates the socket is this session's host, runs, pushes.
 *
 * Host actions flush immediately rather than coalescing. They are all phase transitions,
 * roster edits or settings changes — a handful per year, driven off a projector, where a
 * delay between clicking "Open the market" and the class seeing it would be noticed.
 */
function hostAction(
  broadcaster: Broadcaster,
  socket: AppSocket,
  ack: Ack,
  action: (session: Session) => void,
) {
  try {
    const session = socket.data.role === 'host' && socket.data.roomCode
      ? store.get(socket.data.roomCode)
      : undefined
    if (!session) throw new GameError('NOT_HOST', 'Not authorized as host.')
    action(session)
    ack({ ok: true })
    broadcaster.flushNow(session)
  } catch (error) {
    fail(ack, error)
  }
}

export function registerSockets(io: IO): Broadcaster {
  const broadcaster = new Broadcaster(io)

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
        broadcaster.join(socket, session)
        if (socket.data.playerId) {
          const player = session.getPlayer(socket.data.playerId)
          if (player) player.connected = true
        }
        // This socket needs its state now; the rest of the room only needs to learn that
        // the dot went green, which can ride the next coalesced flush.
        broadcaster.sync(socket, session)
        broadcaster.schedule(session)
      }
    }

    socket.on('host:createSession', ({ hostKey, capMode, seed }, ack) => {
      try {
        if (hostKey !== HOST_KEY) throw new GameError('BAD_KEY', 'Wrong host key.')
        const session = store.create(capMode, seed ?? SEED)
        socket.data.role = 'host'
        socket.data.roomCode = session.state.roomCode
        broadcaster.join(socket, session)
        ack({ ok: true, roomCode: session.state.roomCode, hostToken: session.hostToken })
        broadcaster.sync(socket, session)
      } catch (error) {
        fail(ack, error)
      }
    })

    socket.on('host:setCapMode', ({ mode }, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.setCapMode(mode)))
    socket.on('host:updateSettings', (settings, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.updateSettings(settings)))
    socket.on('host:startYear', (_p, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.startYear()))
    socket.on('host:closeCapStage', (_p, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.closeCapStage()))
    socket.on('host:openTrade', (_p, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.openTrade()))
    socket.on('host:closeTrade', (_p, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.closeTrade()))
    socket.on('host:advanceYear', (_p, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.advanceYear()))
    socket.on('host:endGame', (_p, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.endGame()))
    socket.on('host:kickPlayer', ({ playerId }, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.kickPlayer(playerId)))
    socket.on('host:addBots', ({ botType, count }, ack) =>
      hostAction(broadcaster, socket, ack, (s) => {
        const n = Math.max(1, Math.min(20, Math.floor(Number(count) || 1)))
        for (let i = 0; i < n; i++) s.addBot(botType)
      }))
    socket.on('host:removeBot', ({ playerId }, ack) =>
      hostAction(broadcaster, socket, ack, (s) => s.removeBot(playerId)))

    socket.on('player:join', ({ roomCode, name, industry }, ack) => {
      try {
        const session = store.get(roomCode ?? '')
        if (!session) throw new GameError('NO_ROOM', 'Room not found. Check the code.')
        const { player, token } = session.addPlayer(name ?? '', industry)
        socket.data.role = 'player'
        socket.data.roomCode = session.state.roomCode
        socket.data.playerId = player.id
        broadcaster.join(socket, session)
        ack({
          ok: true,
          playerId: player.id,
          token,
          profile: { industry: player.industry, emissions: player.emissions },
        })
        // The joiner gets state immediately; everyone else learns about the new roster row
        // on the next coalesced flush. A join used to cost a full fan-out per arrival,
        // which is what made a 100-student lobby the worst moment in the game.
        broadcaster.sync(socket, session)
        broadcaster.schedule(session)
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
        // Coalesced: during trade this is the highest-frequency path in the game.
        broadcaster.schedule(session)
      } catch (error) {
        fail(ack, error)
      }
    }

    socket.on('player:submitBid', ({ qty, price }, ack) =>
      playerAction(ack, (s, pid) => s.submitBid(pid, Number(qty), Number(price))))
    socket.on('player:placeOrder', ({ side, qty, price }, ack) =>
      playerAction(ack, (s, pid) => s.placeOrder(pid, side, Number(qty), Number(price))))
    socket.on('player:cancelOrder', ({ orderId }, ack) =>
      playerAction(ack, (s, pid) => s.cancelOrder(pid, String(orderId))))
    socket.on('player:abate', ({ fraction }, ack) =>
      playerAction(ack, (s, pid) => s.setAbatement(pid, Number(fraction))))

    socket.on('disconnect', () => {
      broadcaster.leave(socket)
      if (!socket.data.roomCode || !socket.data.playerId) return
      const session = store.get(socket.data.roomCode)
      const player = session?.getPlayer(socket.data.playerId)
      if (session && player) {
        player.connected = false
        broadcaster.schedule(session)
      }
    })
  })

  return broadcaster
}

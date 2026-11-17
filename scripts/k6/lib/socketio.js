/**
 * A minimal Socket.IO v4 client for k6.
 *
 * k6 has WebSockets but no Socket.IO, so this speaks the protocol by hand over the websocket
 * transport only (no long-polling): Engine.IO v4 framing, the default namespace, events with
 * acks. That is all the game uses.
 *
 *   0{...}            server: Engine.IO open            → we send 40{auth}
 *   2 / 3             server ping / our pong
 *   40{...} / 44{...} namespace connected / refused
 *   42<id>["e",data]  an emit; with <id> it expects an ack
 *   43<id>[response]  the ack of our emit <id>
 *
 * Snapshots are large and pushed several times a second, so they are handed to the caller
 * as the raw JSON string; the caller parses only when it needs to decide something.
 */
import { WebSocket } from 'k6/websockets'
import { clearTimeout, setTimeout } from 'k6/timers'
import { Counter, Trend } from 'k6/metrics'

/** Round trip of every emit, from send to ack, in ms. Tagged with the event name. */
export const ackRtt = new Trend('ack_rtt', true)
/** Emits that got no ack within ACK_TIMEOUT_MS. */
export const ackTimeouts = new Counter('ack_timeouts')
/** Size of each `session:snapshot` push, in characters (≈ bytes). */
export const snapshotSize = new Trend('snapshot_size')
/** `session:snapshot` pushes received, all sockets together. */
export const snapshots = new Counter('snapshots')
/** Sockets that never reached the connected state. */
export const connectFailures = new Counter('ws_connect_failures')
/** Connected sockets that closed without our asking: the server, Render's proxy or the network. */
export const wsDrops = new Counter('ws_drops')
/** From a drop to being connected again, in ms. */
export const wsDowntime = new Trend('ws_downtime', true)
/** Reconnect attempts that failed (another follows). */
export const reconnectFailures = new Counter('ws_reconnect_failures')

const ACK_TIMEOUT_MS = Number(__ENV.ACK_TIMEOUT_MS || 10000)
const CONNECT_TIMEOUT_MS = Number(__ENV.CONNECT_TIMEOUT_MS || 30000)

function digitsEnd(data, from) {
  let i = from
  while (i < data.length && data.charCodeAt(i) >= 48 && data.charCodeAt(i) <= 57) i++
  return i
}

/**
 * Opens a socket and resolves once the default namespace is connected.
 *
 * @param {string} baseUrl  http(s)://host[:port] of the backend
 * @param {object|null} auth  the handshake `auth` (SocketAuth), or null for a fresh socket
 * @param {{ onSnapshot?: (raw: string) => void, onClose?: (info: CloseInfo) => void, failures?: Counter }} handlers
 *   `onSnapshot` gets `["session:snapshot",{...}]` as a string; `JSON.parse(raw)[1]` is the snapshot.
 *   `onClose` gets `{ code, reason, byUs, wasConnected, serverDisconnect }`. `failures` counts a
 *   failed connect (default `ws_connect_failures`).
 */
export function connect(baseUrl, auth, handlers = {}) {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`
    const ws = new WebSocket(url)
    const pending = new Map()
    let seq = 0
    let connected = false
    let closed = false
    let byUs = false
    let serverDisconnect = false
    let settled = false

    const failConnect = (reason) => {
      if (settled) return
      settled = true
      ;(handlers.failures || connectFailures).add(1)
      clearTimeout(connectTimer)
      try { ws.close() } catch (_) { /* already closing */ }
      reject(new Error(reason))
    }
    const connectTimer = setTimeout(() => failConnect('connect timeout'), CONNECT_TIMEOUT_MS)

    const client = {
      /** Emit with an ack. Resolves with the server's response, or a TIMEOUT/CLOSED stand-in. */
      emit(event, payload) {
        return new Promise((done) => {
          if (closed) {
            done({ ok: false, error: 'socket closed', code: 'CLOSED' })
            return
          }
          const id = ++seq
          const t0 = Date.now()
          const timer = setTimeout(() => {
            if (!pending.delete(id)) return
            ackTimeouts.add(1, { event })
            done({ ok: false, error: 'no ack', code: 'TIMEOUT' })
          }, ACK_TIMEOUT_MS)
          pending.set(id, (response) => {
            clearTimeout(timer)
            ackRtt.add(Date.now() - t0, { event })
            done(response)
          })
          ws.send(`42${id}${JSON.stringify([event, payload ?? {}])}`)
        })
      },
      close() {
        closed = true
        byUs = true
        try { ws.close() } catch (_) { /* already closing */ }
      },
      get open() {
        return connected && !closed
      },
    }

    ws.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : String(e.data)
      const type = data.charAt(0)
      if (type === '0') {
        ws.send(`40${auth ? JSON.stringify(auth) : ''}`)
        return
      }
      if (type === '2') {
        ws.send('3')
        return
      }
      if (type !== '4') return
      const packet = data.charAt(1)
      if (packet === '2') {
        const body = data.slice(digitsEnd(data, 2))
        if (body.startsWith('["session:snapshot"')) {
          snapshots.add(1)
          snapshotSize.add(data.length)
          if (handlers.onSnapshot) handlers.onSnapshot(body)
        }
        return
      }
      if (packet === '3') {
        const end = digitsEnd(data, 2)
        const id = Number(data.slice(2, end))
        const cb = pending.get(id)
        if (!cb) return
        pending.delete(id)
        cb(JSON.parse(data.slice(end))[0])
        return
      }
      if (packet === '0') {
        connected = true
        if (!settled) {
          settled = true
          clearTimeout(connectTimer)
          resolve(client)
        }
        return
      }
      if (packet === '4') {
        failConnect(`connect refused: ${data.slice(2)}`)
        return
      }
      if (packet === '1') {
        // The server disconnected this socket (socket.disconnect()). The game never does; a
        // browser would not reconnect after it either.
        serverDisconnect = true
        closed = true
        try { ws.close() } catch (_) { /* already closing */ }
      }
    }

    ws.onerror = (e) => {
      if (!connected) failConnect(`websocket error: ${e && e.error}`)
    }

    ws.onclose = (e) => {
      closed = true
      for (const cb of pending.values()) cb({ ok: false, error: 'socket closed', code: 'CLOSED' })
      pending.clear()
      if (!connected) failConnect('closed before connecting')
      if (handlers.onClose) {
        handlers.onClose({ code: e && e.code, reason: (e && e.reason) || '', byUs, wasConnected: connected, serverDisconnect })
      }
    }
  })
}

/** Resolves true once `promise` settles, or false after `ms`, without leaving a timer behind. */
function within(promise, ms) {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms)
    promise.then(() => {
      clearTimeout(timer)
      done(true)
    })
  })
}

/**
 * A socket that comes back, as the game's browser client does: socket.io-client reconnects on
 * its own and authenticates with the identity it stored at join, so a student whose connection
 * drops is back within seconds and keeps playing. When this socket closes without `close()`, it
 * reconnects with `auth()` after 1 s, then 2, 4 and every 5 s, until it is in or `close()` is
 * called. An emit made while it is away waits for it (up to ACK_TIMEOUT_MS), as socket.io-client
 * buffers it; one whose ack was in flight when it dropped resolves with code CLOSED.
 *
 * @param {() => object|null} auth  the handshake auth for each connection (a player's token once joined)
 * @param {{ onSnapshot?, onDrop?: (info: CloseInfo) => void, onBack?: (awayMs: number, attempts: number) => void }} handlers
 */
export async function resilient(baseUrl, auth, handlers = {}) {
  let stopped = false
  let back = null // while away: resolves once connected again (or stopped)
  let current = null

  const dropped = (info) => {
    if (info.byUs || !info.wasConnected || stopped) return
    wsDrops.add(1)
    if (handlers.onDrop) handlers.onDrop(info)
    if (info.serverDisconnect) stopped = true
    else back = reconnect(Date.now())
  }
  const open = (failures) => connect(baseUrl, auth(), { onSnapshot: handlers.onSnapshot, onClose: dropped, failures })
  async function reconnect(t0) {
    for (let attempt = 1; !stopped; attempt++) {
      await wait(Math.min(5000, 1000 * 2 ** (attempt - 1)))
      if (stopped) return
      try {
        current = await open(reconnectFailures)
      } catch (_) {
        continue // counted in ws_reconnect_failures; try again
      }
      if (stopped) {
        current.close() // closed while this attempt was connecting: an open socket keeps the VU alive
        return
      }
      back = null
      wsDowntime.add(Date.now() - t0)
      if (handlers.onBack) handlers.onBack(Date.now() - t0, attempt)
      return
    }
  }

  current = await open()
  return {
    async emit(event, payload) {
      if (back && !(await within(back, ACK_TIMEOUT_MS))) {
        return { ok: false, error: 'still reconnecting', code: 'CLOSED' }
      }
      return current.emit(event, payload)
    },
    close() {
      stopped = true
      current.close()
    },
    /** Until `close()`: a dropped socket is still open, it is coming back. */
    get open() {
      return !stopped
    },
    /** Connected right now. */
    get connected() {
      return !back && current.open
    },
  }
}

/** @typedef {{ code?: number, reason: string, byUs: boolean, wasConnected: boolean, serverDisconnect: boolean }} CloseInfo */

/** A promise that resolves after `ms`, without blocking the VU's event loop. */
export function wait(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

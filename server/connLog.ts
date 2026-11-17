import type { AppSocket } from './broadcaster'
import type { Session } from './session'

/**
 * Connection diagnostics, logging only (2026-11-17: in a live k6 run 20 of 50 students'
 * websockets closed mid-game and nothing said why).
 *
 * Every socket keeps its last few events in both directions (`in player:placeOrder`,
 * `out snapshot 22 KB`, `out ping`, `in pong`; consecutive snapshots folded into one entry).
 * A drop is logged with Engine.IO's reason, the heartbeat (last ping out, last pong in, last
 * packet in), when packets were last handed to the transport and how many were still waiting,
 * then those events. When the same identity comes back (its token: a reconnect or a reload),
 * how long it was away is logged, and its first events after `afterMs`.
 *
 * Nothing here changes what a socket receives or may do.
 */
export const connLogSettings = { recent: 15, afterMs: 10_000 }

/** Someone leaving on purpose, or the server stopping: one short line, no context. */
const DELIBERATE = new Set(['client namespace disconnect', 'server namespace disconnect', 'server shutting down'])
/** How long a dropped identity is remembered for its "back" line. */
const AWAY_TTL_MS = 30 * 60_000

interface Entry {
  start: number
  end: number
  text: string
  n: number
}

interface Trace {
  opened: number
  events: Entry[]
  /** The first events after a reconnect, until it is logged. */
  capture: Entry[] | null
  lastIn: number
  lastPingOut: number | null
  lastPongIn: number | null
  lastFlush: number | null
}

interface EnginePacket {
  type: string
  data?: unknown
}

const traces = new WeakMap<AppSocket, Trace>()
const away = new Map<string, { at: number; reason: string }>()

function push(list: Entry[], text: string, now: number, cap: number) {
  const last = list[list.length - 1]
  // Snapshots come several times a second: fold a run of them, or they would push out the rest.
  if (last && last.text.startsWith('out snapshot') && text.startsWith('out snapshot')) {
    last.n++
    last.end = now
    last.text = text
    return
  }
  if (list.length >= cap) list.shift()
  list.push({ start: now, end: now, text, n: 1 })
}

function note(t: Trace, text: string) {
  const now = Date.now()
  push(t.events, text, now, connLogSettings.recent)
  if (t.capture && t.capture.length < connLogSettings.recent) push(t.capture, text, now, Infinity)
}

/** `2["player:placeOrder",…` → `player:placeOrder`, a snapshot → `snapshot 22 KB`, an ack → `ack`. */
export function describePacket(data: unknown): string {
  if (typeof data !== 'string') return 'binary'
  const head = data.slice(0, 64)
  const event = /^2\d*\["([^"]+)"/.exec(head)
  if (event) return event[1] === 'session:snapshot' ? `snapshot ${Math.round(data.length / 1024)} KB` : event[1]
  if (head.startsWith('3')) return 'ack'
  if (head.startsWith('0')) return 'connect'
  if (head.startsWith('1')) return 'disconnect'
  return head.slice(0, 12)
}

const secs = (ms: number) => (ms / 1000).toFixed(1)
const ago = (at: number | null, now: number) => (at === null ? 'never' : `${secs(now - at)} s ago`)

/** `-12.0…-3.1 out snapshot 22 KB ×30 · -2.5 in player:placeOrder`, times relative to `ref`. */
export function formatEvents(list: Entry[], ref: number): string {
  if (!list.length) return 'none'
  const rel = (at: number) => `${at >= ref ? '+' : '-'}${secs(Math.abs(at - ref))}`
  return list
    .map((e) => (e.n > 1 ? `${rel(e.start)}…${rel(e.end)} ${e.text} ×${e.n}` : `${rel(e.start)} ${e.text}`))
    .join(' · ')
}

function where(session: Session | undefined): string {
  if (!session) return 'no room'
  const { phase, currentYear } = session.state
  return phase === 'lobby' || phase === 'ended' ? phase : `${phase} y${currentYear + 1}`
}

function who(socket: AppSocket, session: Session | undefined): string {
  const head = `${socket.data.roomCode ?? '—'} ${where(session)}`
  if (socket.data.role === 'host') return `${head} · host`
  if (socket.data.role === 'watcher') return `${head} · host watching ${socket.data.watchId}`
  const player = socket.data.playerId ? session?.getPlayer(socket.data.playerId) : undefined
  return `${head} · ${player ? `"${player.name}" (${player.industry})` : `player ${socket.data.playerId ?? '—'}`}`
}

function identity(socket: AppSocket): string {
  return `${socket.data.roomCode}|${socket.data.role}|${socket.data.playerId ?? socket.data.watchId ?? ''}`
}

/** Start tracing a socket: first thing on connection, before anything is sent to it. */
export function traceConnection(socket: AppSocket) {
  const now = Date.now()
  const t: Trace = { opened: now, events: [], capture: null, lastIn: now, lastPingOut: null, lastPongIn: null, lastFlush: null }
  traces.set(socket, t)
  socket.conn.on('packet', (p: EnginePacket) => {
    t.lastIn = Date.now()
    if (p.type === 'pong') {
      t.lastPongIn = t.lastIn
      note(t, 'in pong')
    } else if (p.type === 'message') {
      note(t, `in ${describePacket(p.data)}`)
    }
  })
  socket.conn.on('packetCreate', (p: EnginePacket) => {
    if (p.type === 'ping') {
      t.lastPingOut = Date.now()
      note(t, 'out ping')
    } else if (p.type === 'message') {
      note(t, `out ${describePacket(p.data)}`)
    }
  })
  socket.conn.on('flush', () => {
    t.lastFlush = Date.now()
  })
}

/** A socket closed: log why, the heartbeat and its last events. Sockets that never joined a room are skipped. */
export function traceDrop(socket: AppSocket, reason: string, session: Session | undefined) {
  const t = traces.get(socket)
  if (!t || !socket.data.roomCode) return
  const now = Date.now()
  const label = who(socket, session)
  if (DELIBERATE.has(reason) || !session || session.state.phase === 'ended') {
    console.log(`[conn] left · ${label} · ${reason} · connected ${secs(now - t.opened)} s`)
    return
  }
  for (const [k, v] of away) if (now - v.at > AWAY_TTL_MS) away.delete(k)
  away.set(identity(socket), { at: now, reason })
  const unsent = (socket.conn as unknown as { writeBuffer?: unknown[] }).writeBuffer?.length ?? 0
  console.log(
    `[conn] drop · ${label} · ${reason} · connected ${secs(now - t.opened)} s · last packet in ${ago(t.lastIn, now)}` +
      ` · last ping out ${ago(t.lastPingOut, now)} · last pong in ${ago(t.lastPongIn, now)}` +
      ` · last flush ${ago(t.lastFlush, now)} · unsent packets ${unsent}`,
  )
  console.log(`[conn]   before: ${formatEvents(t.events, now)}`)
}

/** A socket came in with a stored identity. If that identity had dropped, log how long it was away. */
export function traceResume(socket: AppSocket, session: Session) {
  const k = identity(socket)
  const gone = away.get(k)
  if (!gone) return
  away.delete(k)
  const back = Date.now()
  console.log(`[conn] back · ${who(socket, session)} · after ${secs(back - gone.at)} s (dropped: ${gone.reason})`)
  const t = traces.get(socket)
  if (!t) return
  t.capture = t.events.map((e) => ({ ...e })) // the socket is new: whatever it logged so far is "after"
  setTimeout(() => {
    console.log(`[conn]   after: ${formatEvents(t.capture ?? [], back)}`)
    t.capture = null
  }, connLogSettings.afterMs).unref()
}

export const PORT = Number(process.env.PORT) || 3001

/**
 * How often the bot driver wakes (ms). Human-paced — bots never out-click a person.
 * Lives here rather than in GameConfig because BotManager runs a single interval
 * across every live session, so it cannot be a per-session setting.
 */
export const BOT_TICK_MS = Number(process.env.BOT_TICK_MS) || 2500

/**
 * Coalescing window for state pushes (ms). Every mutation schedules a flush rather than
 * broadcasting inline, so a burst of orders from 100 students costs one fan-out instead of
 * one each. Phase transitions bypass this and flush immediately — see Broadcaster.flushNow.
 */
export const FLUSH_MS = Number(process.env.BROADCAST_FLUSH_MS) || 100

/**
 * A big room flushes less often: the window grows by this many ms per connected socket, up to
 * FLUSH_MAX_MS (2026-11-17). Every flush sends every socket its whole snapshot, so its cost grows
 * with the room twice over (more sockets, bigger roster). At 5 ms a 50-socket room flushes every
 * 250 ms and a 100-socket room every 500 ms instead of every 100 ms. Acks and host transitions
 * are not delayed: acks do not wait for a flush, and host actions `flushNow`. 0 turns it off.
 */
export const FLUSH_PER_SOCKET_MS =
  process.env.BROADCAST_FLUSH_PER_SOCKET_MS !== undefined ? Number(process.env.BROADCAST_FLUSH_PER_SOCKET_MS) : 5
export const FLUSH_MAX_MS = Number(process.env.BROADCAST_FLUSH_MAX_MS) || 1000

/** Instructor secret for creating/controlling sessions. Set HOST_KEY in production. */
export const HOST_KEY = process.env.HOST_KEY || 'letmein'

/** Optional fixed seed for reproducible classroom sessions. */
export const SEED = process.env.SEED ? Number(process.env.SEED) : undefined

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

/** Instructor secret for creating/controlling sessions. Set HOST_KEY in production. */
export const HOST_KEY = process.env.HOST_KEY || 'letmein'

/** Optional fixed seed for reproducible classroom sessions. */
export const SEED = process.env.SEED ? Number(process.env.SEED) : undefined

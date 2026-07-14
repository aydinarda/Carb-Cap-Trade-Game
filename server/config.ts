export const PORT = Number(process.env.PORT) || 3001

/** Instructor secret for creating/controlling sessions. Set HOST_KEY in production. */
export const HOST_KEY = process.env.HOST_KEY || 'letmein'

/** Optional fixed seed for reproducible classroom sessions. */
export const SEED = process.env.SEED ? Number(process.env.SEED) : undefined

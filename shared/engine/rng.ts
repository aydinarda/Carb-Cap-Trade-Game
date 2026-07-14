export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  uniform(low: number, high: number): number
  /** Uniform integer in [low, high] inclusive. */
  int(low: number, high: number): number
  normal(mean: number, stdDev: number): number
  choice<T>(items: readonly T[], probs?: readonly number[]): T
}

/**
 * Deterministic seeded PRNG (mulberry32) with Box–Muller gaussians.
 * The notebook uses numpy's Mersenne Twister; bit-identical streams are not
 * reproducible in JS, so the engine reproduces the formulas, not the stream.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  let spare: number | null = null
  const normal = (mean: number, stdDev: number): number => {
    if (spare !== null) {
      const value = spare
      spare = null
      return mean + stdDev * value
    }
    let u = 0
    while (u === 0) u = next()
    const v = next()
    const radius = Math.sqrt(-2 * Math.log(u))
    spare = radius * Math.sin(2 * Math.PI * v)
    return mean + stdDev * radius * Math.cos(2 * Math.PI * v)
  }

  return {
    next,
    uniform: (low, high) => low + (high - low) * next(),
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    normal,
    choice: (items, probs) => {
      if (!probs) return items[Math.floor(next() * items.length)]
      const roll = next()
      let cumulative = 0
      for (let i = 0; i < items.length; i++) {
        cumulative += probs[i]
        if (roll < cumulative) return items[i]
      }
      return items[items.length - 1]
    },
  }
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

import { round1 } from './rng'

/**
 * Regulator sale at the cap stage. The yearly pool is the part of the baseline
 * NOT distributed for free (Σbaseline × (1 − freeCreditRatio)), so the total
 * cap is preserved. If total requests exceed the pool, grants are pro-rated.
 */
export function grantRegulator(
  requests: Record<string, number>,
  pool: number,
): Record<string, number> {
  const total = Object.values(requests).reduce((a, b) => a + b, 0)
  const granted: Record<string, number> = {}
  if (total <= 0) {
    for (const id of Object.keys(requests)) granted[id] = 0
    return granted
  }
  const ratio = total <= pool ? 1 : pool / total
  for (const [id, qty] of Object.entries(requests)) {
    granted[id] = round1(qty * ratio)
  }
  return granted
}

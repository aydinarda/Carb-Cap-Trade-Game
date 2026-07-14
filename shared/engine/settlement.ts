import type { PlayerSettlement } from '../types'
import { round1 } from './rng'

/**
 * Year-end penalty settlement (per the course design notes):
 * players short of credits (realized > held) are penalised in two tiers —
 *  1. credits still left unsold in the market are distributed pro-rata to the
 *     shorts; that covered part costs the LOW penalty rate (credits were
 *     available, and unsold credits would expire anyway),
 *  2. any shortage beyond the leftover pool costs the HIGH penalty rate.
 * Sellers are unaffected; unused credits expire at year end (no banking).
 */
export function settleYear(
  realized: Record<string, number>,
  creditsHeld: Record<string, number>,
  leftoverPool: number,
  rates: { lowPenaltyRate: number; highPenaltyRate: number },
): {
  settlement: Record<string, PlayerSettlement>
  leftoverDistributed: number
} {
  const shortages: Record<string, number> = {}
  let totalShortage = 0
  for (const id of Object.keys(realized)) {
    const shortage = round1(Math.max(0, realized[id] - (creditsHeld[id] ?? 0)))
    shortages[id] = shortage
    totalShortage += shortage
  }

  const distributable = Math.min(leftoverPool, totalShortage)
  const settlement: Record<string, PlayerSettlement> = {}
  let leftoverDistributed = 0

  for (const id of Object.keys(realized)) {
    const shortage = shortages[id]
    const covered =
      totalShortage > 0 ? round1((shortage / totalShortage) * distributable) : 0
    const uncovered = round1(Math.max(0, shortage - covered))
    const penalty = round1(covered * rates.lowPenaltyRate + uncovered * rates.highPenaltyRate)
    settlement[id] = { shortage, coveredByLeftover: covered, penalty }
    leftoverDistributed += covered
  }

  return { settlement, leftoverDistributed: round1(leftoverDistributed) }
}

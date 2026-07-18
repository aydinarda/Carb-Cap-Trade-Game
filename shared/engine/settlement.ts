import type { PlayerSettlement } from '../types'
import { round1 } from './rng'

/**
 * Year-end cost settlement (cost-ledger model):
 *  - purchaseCost = every bought credit (regulator cap stage + fixed-price
 *    secondary market) costs `regulatorPrice`. Free-allocated credits cost 0.
 *  - penaltyCost = emissions left uncovered (realized > creditsHeld) cost
 *    `penaltyRate` each.
 *  - yearCost = purchaseCost + penaltyCost, added to the cumulative score
 *    (lowest wins). Surplus credits simply expire (no banking, no sell-back).
 *
 * With `penaltyRate > regulatorPrice`, covering a shortage by buying beats
 * defaulting, so the price has teeth.
 */
export function settleYear(
  realized: Record<string, number>,
  creditsHeld: Record<string, number>,
  purchased: Record<string, number>,
  rates: { regulatorPrice: number; penaltyRate: number },
): {
  settlement: Record<string, PlayerSettlement>
} {
  const settlement: Record<string, PlayerSettlement> = {}
  for (const id of Object.keys(realized)) {
    const shortage = round1(Math.max(0, realized[id] - (creditsHeld[id] ?? 0)))
    const purchaseCost = round1((purchased[id] ?? 0) * rates.regulatorPrice)
    const penaltyCost = round1(shortage * rates.penaltyRate)
    settlement[id] = {
      shortage,
      purchaseCost,
      penaltyCost,
      yearCost: round1(purchaseCost + penaltyCost),
    }
  }
  return { settlement }
}

import type { PlayerSettlement } from '../types'
import { round1 } from './rng'

/**
 * Year-end cost settlement (cost-ledger model):
 *  - purchaseCost = every bought credit (regulator cap stage + fixed-price
 *    secondary market) costs `regulatorPrice`. Free-allocated credits cost 0.
 *  - sellIncome = every credit sold back earns `sellPrice`.
 *  - penaltyCost = emissions left uncovered (realized > creditsHeld) cost
 *    `penaltyRate` each.
 *  - yearCost = purchaseCost − sellIncome + penaltyCost, added to the cumulative
 *    score (lowest wins). Can be negative for a clean company that sells surplus.
 *    Unsold surplus credits expire (no banking).
 *
 * With `penaltyRate > regulatorPrice`, covering a shortage by buying beats
 * defaulting. If `sellPrice > regulatorPrice`, buy-and-resell arbitrage is
 * possible — that is a deliberate instructor choice, not prevented here.
 */
export function settleYear(
  realized: Record<string, number>,
  creditsHeld: Record<string, number>,
  purchased: Record<string, number>,
  sold: Record<string, number>,
  rates: { regulatorPrice: number; sellPrice: number; penaltyRate: number },
): {
  settlement: Record<string, PlayerSettlement>
} {
  const settlement: Record<string, PlayerSettlement> = {}
  for (const id of Object.keys(realized)) {
    const shortage = round1(Math.max(0, realized[id] - (creditsHeld[id] ?? 0)))
    const purchaseCost = round1((purchased[id] ?? 0) * rates.regulatorPrice)
    const sellIncome = round1((sold[id] ?? 0) * rates.sellPrice)
    const penaltyCost = round1(shortage * rates.penaltyRate)
    settlement[id] = {
      shortage,
      purchaseCost,
      sellIncome,
      penaltyCost,
      yearCost: round1(purchaseCost - sellIncome + penaltyCost),
    }
  }
  return { settlement }
}

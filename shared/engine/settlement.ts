import type { PlayerSettlement } from '../types'
import { round1 } from './rng'

/**
 * Year-end cost settlement (cost-ledger model):
 *  - purchaseCost = money spent acquiring credits, computed by the caller (cap
 *    stage: regulator sale at `regulatorPrice` OR auction at the clearing price;
 *    plus the fixed-price secondary market). Free-allocated credits cost 0.
 *  - sellIncome = every credit sold back earns `sellPrice`.
 *  - penaltyCost = emissions left uncovered (realized > creditsHeld) cost
 *    `penaltyRate` each.
 *  - abatementCost = cost of the emission cuts the company invested in.
 *  - yearCost = abatementCost + purchaseCost − sellIncome + penaltyCost, added to
 *    the cumulative score. Can be negative for a clean company that sells surplus.
 *    Unsold surplus credits expire (no banking).
 *
 * Penalty rate is kept above the credit price so covering beats defaulting.
 */
export function settleYear(
  realized: Record<string, number>,
  creditsHeld: Record<string, number>,
  purchaseCost: Record<string, number>,
  sold: Record<string, number>,
  abatementCost: Record<string, number>,
  rates: { sellPrice: number; penaltyRate: number },
): {
  settlement: Record<string, PlayerSettlement>
} {
  const settlement: Record<string, PlayerSettlement> = {}
  for (const id of Object.keys(realized)) {
    const shortage = round1(Math.max(0, realized[id] - (creditsHeld[id] ?? 0)))
    const abateCost = round1(abatementCost[id] ?? 0)
    const purchCost = round1(purchaseCost[id] ?? 0)
    const sellIncome = round1((sold[id] ?? 0) * rates.sellPrice)
    const penaltyCost = round1(shortage * rates.penaltyRate)
    settlement[id] = {
      shortage,
      abatementCost: abateCost,
      purchaseCost: purchCost,
      sellIncome,
      penaltyCost,
      yearCost: round1(abateCost + purchCost - sellIncome + penaltyCost),
    }
  }
  return { settlement }
}

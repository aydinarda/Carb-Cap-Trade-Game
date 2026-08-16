import type { PlayerSettlement } from '../types'
import { round1 } from './rng'

/**
 * Year-end cost settlement (cost-ledger model). purchaseCost and sellIncome are
 * passed in as MONEY (the caller derives them from the auction clearing price and
 * the market trade prices):
 *  - purchaseCost = cash spent acquiring credits (auction + market buys). Free = 0.
 *  - sellIncome = cash earned selling credits in the market.
 *  - penaltyCost = emissions left uncovered (realized > creditsHeld) × penaltyRate.
 *  - abatementCost = cost of the emission cuts the company invested in.
 *  - yearCost = abatementCost + purchaseCost − sellIncome + penaltyCost, added to
 *    the cumulative score. Can be negative for a clean company that sells surplus.
 *
 * The penalty is a real EU-ETS fine, not a price ceiling: the uncovered shortfall
 * ALSO carries forward as a make-good debt (handled in the session), so defaulting
 * costs the fine now plus buying the missing allowances later.
 */
export function settleYear(
  realized: Record<string, number>,
  creditsHeld: Record<string, number>,
  purchaseCost: Record<string, number>,
  sellIncome: Record<string, number>,
  abatementCost: Record<string, number>,
  rates: { penaltyRate: number },
): {
  settlement: Record<string, PlayerSettlement>
} {
  const settlement: Record<string, PlayerSettlement> = {}
  for (const id of Object.keys(realized)) {
    const shortage = round1(Math.max(0, realized[id] - (creditsHeld[id] ?? 0)))
    const abateCost = round1(abatementCost[id] ?? 0)
    const purchCost = round1(purchaseCost[id] ?? 0)
    const sellIncomeVal = round1(sellIncome[id] ?? 0)
    const penaltyCost = round1(shortage * rates.penaltyRate)
    settlement[id] = {
      shortage,
      abatementCost: abateCost,
      purchaseCost: purchCost,
      sellIncome: sellIncomeVal,
      penaltyCost,
      yearCost: round1(abateCost + purchCost - sellIncomeVal + penaltyCost),
    }
  }
  return { settlement }
}

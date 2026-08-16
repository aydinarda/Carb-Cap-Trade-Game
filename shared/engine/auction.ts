import { round1 } from './rng'

export interface AuctionBid {
  qty: number
  /** Max price the firm is willing to pay per credit. */
  price: number
}

/**
 * Single-round, sealed-bid, uniform-price auction (EU-ETS style primary market).
 * Bids are ranked by price (highest first) and filled until the fixed `supply`
 * runs out. The clearing price is the marginal (lowest accepted) bid; EVERY
 * winner pays that single clearing price. Bids at the marginal price share the
 * remaining supply pro-rata. If total demand ≤ supply, all bids win in full and
 * the clearing price is the lowest submitted bid.
 */
export function clearAuction(
  bids: Record<string, AuctionBid>,
  supply: number,
): { clearingPrice: number; awarded: Record<string, number> } {
  const awarded: Record<string, number> = {}
  for (const id of Object.keys(bids)) awarded[id] = 0

  const entries = Object.entries(bids)
    .filter(([, b]) => b.qty > 0 && b.price > 0)
    .sort((a, b) => b[1].price - a[1].price)

  if (entries.length === 0 || supply <= 0) return { clearingPrice: 0, awarded }

  const totalDemand = entries.reduce((s, [, b]) => s + b.qty, 0)
  if (totalDemand <= supply) {
    for (const [id, b] of entries) awarded[id] = round1(b.qty)
    return { clearingPrice: round1(entries[entries.length - 1][1].price), awarded }
  }

  // Find the marginal price at which cumulative demand crosses the supply.
  let cum = 0
  let marginalPrice = entries[entries.length - 1][1].price
  for (const [, b] of entries) {
    cum += b.qty
    if (cum >= supply) {
      marginalPrice = b.price
      break
    }
  }

  const aboveQty = entries
    .filter(([, b]) => b.price > marginalPrice)
    .reduce((s, [, b]) => s + b.qty, 0)
  const atMarginalQty = entries
    .filter(([, b]) => b.price === marginalPrice)
    .reduce((s, [, b]) => s + b.qty, 0)
  const remainingForMarginal = Math.max(0, supply - aboveQty)
  const ratio = atMarginalQty > 0 ? Math.min(1, remainingForMarginal / atMarginalQty) : 0

  for (const [id, b] of entries) {
    if (b.price > marginalPrice) awarded[id] = round1(b.qty)
    else if (b.price === marginalPrice) awarded[id] = round1(b.qty * ratio)
    else awarded[id] = 0
  }
  return { clearingPrice: round1(marginalPrice), awarded }
}

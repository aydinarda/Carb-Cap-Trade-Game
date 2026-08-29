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
  /**
   * Floor below which the regulator does not sell, as every real ETS auction has.
   *
   * Without one an UNDERSUBSCRIBED auction clears at the lowest bid on the book, so the most
   * timid bidder sets the price for everybody — measured, that put the clearing at 12 while
   * the secondary market traded at 28, and handed every winner the difference. A reserve
   * price is what stops a thin auction from pricing the whole year.
   *
   * Bids below it win nothing, exactly as they would in a real sale.
   */
  reservePrice = 0,
): { clearingPrice: number; awarded: Record<string, number> } {
  const awarded: Record<string, number> = {}
  for (const id of Object.keys(bids)) awarded[id] = 0

  const entries = Object.entries(bids)
    .filter(([, b]) => b.qty > 0 && b.price > 0 && b.price >= reservePrice)
    .sort((a, b) => b[1].price - a[1].price)

  if (entries.length === 0 || supply <= 0) return { clearingPrice: 0, awarded }

  const totalDemand = entries.reduce((s, [, b]) => s + b.qty, 0)
  if (totalDemand <= supply) {
    // Undersubscribed: everyone who cleared the reserve is filled, and the price is the
    // reserve itself rather than whatever the least eager winner happened to offer.
    for (const [id, b] of entries) awarded[id] = round1(b.qty)
    const lowest = entries[entries.length - 1][1].price
    return { clearingPrice: round1(Math.max(reservePrice, lowest)), awarded }
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
  return { clearingPrice: round1(Math.max(reservePrice, marginalPrice)), awarded }
}

import { round1 } from './rng'

/** One step of a bid: this many credits at up to this price each. */
export interface AuctionStep {
  qty: number
  /** Max price the firm is willing to pay per credit. */
  price: number
}

/** Most steps a sweep may have — enough for a demand curve, few enough to read at a glance. */
export const MAX_SWEEP_STEPS = 5

/**
 * A company's sealed bid. Usually one step; a SWEEP ("100 at up to 10, 100 more at up to 30")
 * lists its steps in `steps`, and then `qty` and `price` summarise it — the total quantity and
 * the highest step price — so everything that reads a bid as one number still reads it right.
 */
export interface AuctionBid extends AuctionStep {
  steps?: AuctionStep[]
}

/** The steps a bid stands for: its sweep, or the bid itself. */
export function bidSteps(bid: AuctionBid): AuctionStep[] {
  return bid.steps?.length ? bid.steps : [bid]
}

/**
 * Single-round, sealed-bid, uniform-price auction (EU-ETS style primary market).
 * Bids are ranked by price (highest first) and filled until the fixed `supply`
 * runs out. The clearing price is the marginal (lowest accepted) bid; EVERY
 * winner pays that single clearing price. Bids at the marginal price share the
 * remaining supply pro-rata. If total demand ≤ supply, all bids win in full and
 * the clearing price is the lowest submitted bid.
 *
 * A sweep enters as its separate steps, ranked with everyone else's: a company wins every
 * step priced above the clearing price in full, its marginal step pro-rata, and pays the one
 * clearing price for all of it. A one-step bid clears exactly as it always did.
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

  const entries: [string, AuctionStep][] = Object.entries(bids)
    .flatMap(([id, bid]) => bidSteps(bid).map((step): [string, AuctionStep] => [id, step]))
    .filter(([, b]) => b.qty > 0 && b.price > 0 && b.price >= reservePrice)
    .sort((a, b) => b[1].price - a[1].price)
  // A company's award is the sum over its steps; with one step this is that step's award.
  const add = (id: string, qty: number) => {
    awarded[id] = round1(awarded[id] + round1(qty))
  }

  if (entries.length === 0 || supply <= 0) return { clearingPrice: 0, awarded }

  const totalDemand = entries.reduce((s, [, b]) => s + b.qty, 0)
  if (totalDemand <= supply) {
    // Undersubscribed: everyone who cleared the reserve is filled, and the price is the
    // reserve itself rather than whatever the least eager winner happened to offer.
    for (const [id, b] of entries) add(id, b.qty)
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
    if (b.price > marginalPrice) add(id, b.qty)
    else if (b.price === marginalPrice) add(id, b.qty * ratio)
  }
  return { clearingPrice: round1(Math.max(reservePrice, marginalPrice)), awarded }
}

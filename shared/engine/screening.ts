import type { Trade } from '../types'
import { round1 } from './rng'

/**
 * Market-cornering screening: which companies look like they cornered the market this round.
 *
 * Two kinds of signal, and a company is flagged only when it shows BOTH — either alone is
 * ordinary (hedgers hold more than they need; plenty of firms sell at a profit):
 *
 *   concentration   it took far more than it needs, or a large share of the supply
 *                   - won more at the auction than `overNeed` × what it still had to cover
 *                   - won `auctionShare` or more of the auction supply
 *                   - held `heldShare` or more of the credits in circulation after the cap stage,
 *                     AND more than `overNeed` × its planned emission (a big emitter in a
 *                     small class holds a large share just by being big)
 *   exploitation    it used that position against the market
 *                   - resold `resaleShare` or more of what it acquired, at `resaleMarkup` × the
 *                     reference or more (the auction price; in a mode without one, what it paid)
 *                   - made `sellerShare` or more of the round's sales while the price ran to
 *                     `spike` × the reference or more
 *
 * Market makers provide liquidity by design and are never screened. Flagging only lists a
 * company and tells it so; any penalty is the instructor's decision.
 */

export interface ScreeningThresholds {
  overNeed: number
  minAuctionShare: number
  auctionShare: number
  heldShare: number
  resaleShare: number
  resaleMarkup: number
  sellerShare: number
  spike: number
}

export interface ScreeningCompany {
  id: string
  /** Market makers are never screened. */
  exempt: boolean
  planned: number
  freeAllocation: number
  carriedIn: number
  /** Won at the auction this round. */
  auctionAward: number
}

export interface ScreeningRound {
  companies: ScreeningCompany[]
  /** The auction supply this round; 0 where there is no auction. */
  pool: number
  auctionPrice: number | null
  /** Last round's closing price, the reference where there is neither an auction nor own buys. */
  previousClose: number | null
  trades: Trade[]
}

/** Why each flagged company was flagged, in words; companies not flagged are absent. */
export function screenRound(round: ScreeningRound, t: ScreeningThresholds): Record<string, string[]> {
  const volume = round.trades.reduce((a, tr) => a + tr.qty, 0)
  const priceMax = round.trades.reduce((m, tr) => Math.max(m, tr.price), 0)
  const afterCap = new Map(round.companies.map((c) => [c.id, c.freeAllocation + c.auctionAward + c.carriedIn]))
  const circulating = [...afterCap.values()].reduce((a, v) => a + Math.max(0, v), 0)
  const hasAuction = (round.auctionPrice ?? 0) > 0 && round.pool > 0
  const out: Record<string, string[]> = {}

  for (const c of round.companies) {
    if (c.exempt) continue
    let bought = 0
    let sold = 0
    let buyCash = 0
    let sellCash = 0
    for (const tr of round.trades) {
      if (tr.buyerId === c.id) {
        bought += tr.qty
        buyCash += tr.qty * tr.price
      }
      if (tr.sellerId === c.id) {
        sold += tr.qty
        sellCash += tr.qty * tr.price
      }
    }
    const need = Math.max(0, c.planned - c.freeAllocation - c.carriedIn)
    const share = hasAuction ? c.auctionAward / round.pool : 0
    const held = afterCap.get(c.id) ?? 0
    const heldShare = circulating > 0 ? Math.max(0, held) / circulating : 0
    const buyVwap = bought > 0 ? buyCash / bought : null
    const sellVwap = sold > 0 ? sellCash / sold : null
    const reference = hasAuction ? (round.auctionPrice as number) : (buyVwap ?? round.previousClose)
    const acquired = c.auctionAward + bought

    const concentration: string[] = []
    if (hasAuction && share >= t.minAuctionShare && c.auctionAward > t.overNeed * need) {
      concentration.push(
        `won ${round1(c.auctionAward).toLocaleString()} t at the auction, ${need > 0 ? `${round1(c.auctionAward / need)}× its need of ${round1(need).toLocaleString()} t` : 'with nothing left to cover'}`,
      )
    }
    if (hasAuction && share >= t.auctionShare) {
      concentration.push(`took ${Math.round(share * 100)}% of the auction supply`)
    }
    if (heldShare >= t.heldShare && held > t.overNeed * c.planned) {
      concentration.push(`held ${Math.round(heldShare * 100)}% of the credits in circulation, ${round1(held / Math.max(1, c.planned))}× its emission`)
    }

    const exploitation: string[] = []
    if (reference !== null && reference > 0) {
      if (acquired > 0 && sold >= t.resaleShare * acquired && sellVwap !== null && sellVwap >= t.resaleMarkup * reference) {
        exploitation.push(
          `resold ${round1(sold).toLocaleString()} t (${Math.round((sold / acquired) * 100)}% of what it acquired) at ${round1(sellVwap)}, ${round1(sellVwap / reference)}× ${hasAuction ? 'the auction price' : 'what it paid'}`,
        )
      }
      if (volume > 0 && sold / volume >= t.sellerShare && priceMax >= t.spike * reference) {
        exploitation.push(`made ${Math.round((sold / volume) * 100)}% of the round's sales while the price ran to ${round1(priceMax / reference)}× the reference`)
      }
    }

    if (concentration.length && exploitation.length) out[c.id] = [...concentration, ...exploitation]
  }
  return out
}

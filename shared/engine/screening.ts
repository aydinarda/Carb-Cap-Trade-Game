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

// ---- the stock ledger behind the active screening ---------------------------------------------

/**
 * The active screening's memory across rounds (the user's design, 2026-11-18): what each company
 * holds ABOVE its need that it BOUGHT, what that stock cost, and the profit it made selling it.
 * `screenRound` above sees one round at a time, so a company that stocks up over several rounds
 * and sells in a later one slipped through it; this ledger does not forget.
 *
 *  - The keep line is `keepMultiple` × planned emission, the same line the penalty takes back to.
 *  - Tonnes bought at the auction or in the market that lift holdings above the line enter the
 *    stock at their price. Free allocation, surplus banked from abatement and anything held up to
 *    the line never do, so an honest company selling what it saved is not touched.
 *  - A sale takes tonnes out of the stock first. What it fetched above the stock's average cost is
 *    extra profit; a sale below cost counts 0, never a credit.
 *  - Stock the company turns out to need — it surrendered it, so its holdings came back toward the
 *    line — leaves at cost, with no profit: at each year's start the stock is cut to whatever still
 *    sits above that year's line.
 *  - Credits the instructor confiscates leave the stock first, at cost.
 */
export interface StockBook {
  /** Tonnes bought above the keep line and still held. */
  excess: number
  /** What those tonnes cost in total (€). */
  cost: number
  /** Extra profit realised selling such tonnes above their cost, since the game began (€). */
  realized: number
  /** Tonnes sold out of the stock so far, what they fetched and what they had cost. */
  soldTonnes: number
  soldValue: number
  soldCost: number
}

export const EMPTY_BOOK: Readonly<StockBook> = { excess: 0, cost: 0, realized: 0, soldTonnes: 0, soldValue: 0, soldCost: 0 }

export interface StockCompany {
  id: string
  /** Pure traders (market makers, speculators) have no need to measure against: not tracked. */
  exempt: boolean
  /** `keepMultiple` × this year's planned emission. */
  keep: number
  /** Free allocation + carried in (a make-good debt is negative), before the cap stage. */
  startHeld: number
  /** Won at this year's auction (0 before it closes, or where there is none), and its price. */
  award: number
  awardPrice: number
}

/** A confiscation, placed among the year's trades: it happened when `atTrade` trades had printed. */
export interface StockConfiscation {
  playerId: string
  qty: number
  atTrade: number
}

function trimStock(b: StockBook, room: number) {
  if (b.excess <= room) return
  b.cost = room > 0 ? (b.cost * room) / b.excess : 0
  b.excess = Math.max(0, room)
}

function buyIntoStock(b: StockBook, held: number, keep: number, qty: number, price: number): number {
  if (!(qty > 0)) return held
  const after = held + qty
  const added = Math.min(qty, Math.max(0, after - keep - b.excess))
  if (added > 0) {
    b.excess += added
    b.cost += added * price
  }
  return after
}

function takeOutOfStock(b: StockBook, qty: number, price: number | null) {
  const matched = Math.min(qty, b.excess)
  if (!(matched > 0)) return
  const avg = b.cost / b.excess
  if (price !== null) {
    b.realized += Math.max(0, price - avg) * matched
    b.soldTonnes += matched
    b.soldValue += matched * price
    b.soldCost += matched * avg
  }
  b.cost -= avg * matched
  b.excess -= matched
  if (b.excess < 1e-9) {
    b.excess = 0
    b.cost = 0
  }
}

/**
 * One year folded into the ledger: the books as the year opened, the companies' lines and opening
 * holdings, the auction, then every trade and confiscation in the order they happened. Returns the
 * books as they stand after the last of them. Pure; `books` is not modified.
 */
export function replayStockYear(
  books: Readonly<Record<string, StockBook>>,
  companies: readonly StockCompany[],
  trades: readonly Trade[],
  confiscations: readonly StockConfiscation[] = [],
): Record<string, StockBook> {
  const out: Record<string, StockBook> = {}
  const held = new Map<string, number>()
  const keep = new Map<string, number>()
  for (const c of companies) {
    if (c.exempt) continue
    const b = { ...(books[c.id] ?? EMPTY_BOOK) }
    trimStock(b, Math.max(0, c.startHeld - c.keep))
    held.set(c.id, buyIntoStock(b, c.startHeld, c.keep, c.award, c.awardPrice))
    keep.set(c.id, c.keep)
    out[c.id] = b
  }
  const queue = [...confiscations].sort((a, b) => a.atTrade - b.atTrade)
  let next = 0
  const confiscateUpTo = (index: number) => {
    while (next < queue.length && queue[next].atTrade <= index) {
      const { playerId, qty } = queue[next++]
      const b = out[playerId]
      if (!b) continue
      takeOutOfStock(b, qty, null)
      held.set(playerId, (held.get(playerId) ?? 0) - qty)
    }
  }
  trades.forEach((t, i) => {
    confiscateUpTo(i)
    const buyer = out[t.buyerId]
    if (buyer) held.set(t.buyerId, buyIntoStock(buyer, held.get(t.buyerId) ?? 0, keep.get(t.buyerId) ?? 0, t.qty, t.price))
    const seller = out[t.sellerId]
    if (seller) {
      takeOutOfStock(seller, t.qty, t.price)
      held.set(t.sellerId, (held.get(t.sellerId) ?? 0) - t.qty)
    }
  })
  confiscateUpTo(Number.POSITIVE_INFINITY)
  return out
}

export type ScreeningColor = 'none' | 'yellow' | 'red'

export interface StockThresholds {
  /** Stock bought above the keep line ÷ planned emission at which a company turns yellow / red. */
  yellowExcess: number
  redExcess: number
  /** Open extra profit ÷ baseline emission (€ per tonne, the leaderboard's unit) for yellow / red. */
  yellowProfit: number
  redProfit: number
}

export interface StockSignals {
  color: ScreeningColor
  /** Stock bought above the keep line ÷ planned emission. */
  excessRatio: number
  /** Open extra profit ÷ baseline emission, € per tonne. */
  profitPerTonne: number
  reasons: string[]
}

const euros = (v: number) => `€${Math.round(v).toLocaleString('en-US')}`

/**
 * The colour the host's list shows a company in, and why: the worse of its two measures. Both are
 * scaled to the company's size so big and small emitters are judged alike — the stock by its
 * planned emission, the profit by its baseline emission as the leaderboard is.
 */
export function stockSignals(
  book: Readonly<StockBook>,
  planned: number,
  baseline: number,
  openProfit: number,
  t: StockThresholds,
): StockSignals {
  const excessRatio = book.excess / Math.max(1, planned)
  const profitPerTonne = openProfit / Math.max(1, baseline)
  const level = (value: number, yellow: number, red: number): ScreeningColor =>
    value >= red ? 'red' : value > 0 && value >= yellow ? 'yellow' : 'none'
  const byStock = level(excessRatio, t.yellowExcess, t.redExcess)
  const byProfit = level(profitPerTonne, t.yellowProfit, t.redProfit)
  const rank = { none: 0, yellow: 1, red: 2 } as const
  const color = rank[byStock] >= rank[byProfit] ? byStock : byProfit
  const reasons: string[] = []
  if (byStock !== 'none') {
    reasons.push(
      `holds ${round1(book.excess).toLocaleString('en-US')} t it bought above its need, ${round1(excessRatio)}× its planned emission` +
        (book.excess > 0 ? `, at ${euros(book.cost / book.excess)}/t on average` : ''),
    )
  }
  if (byProfit !== 'none') {
    const avgSale = book.soldTonnes > 0 ? book.soldValue / book.soldTonnes : null
    const avgCost = book.soldTonnes > 0 ? book.soldCost / book.soldTonnes : null
    reasons.push(
      `made ${euros(openProfit)} of extra profit selling stock it bought above its need` +
        (avgSale !== null && avgCost !== null ? ` (sold at ${euros(avgSale)}/t, bought at ${euros(avgCost)}/t)` : '') +
        `, ${euros(profitPerTonne)} per tonne of its baseline`,
    )
  }
  return { color, excessRatio, profitPerTonne, reasons }
}

import type { Trade } from '@shared/types'

/** One notification on the trade screen: what the player's newly filled trades add up to. */
export interface FillNotice {
  /** The id of the first trade it covers. */
  key: string
  side: 'buy' | 'sell'
  /** Credits, over all the trades it covers. */
  qty: number
  /** Σ qty × price. */
  total: number
  avgPrice: number
  /** How many fills it covers. */
  trades: number
}

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * The fills in `myTrades` that are not in `seen` yet, adding them to it: one notice per side. An
 * order that sweeps several price levels fills in one go, so it arrives in one snapshot and becomes
 * one notice; fills that arrive in later snapshots become notices of their own.
 */
export function newFills(myTrades: readonly Trade[], seen: Set<string>, youId: string): FillNotice[] {
  const bySide = new Map<FillNotice['side'], FillNotice>()
  // myTrades is newest first: walked oldest first, so a notice is keyed by its first fill.
  for (let i = myTrades.length - 1; i >= 0; i--) {
    const t = myTrades[i]
    if (seen.has(t.id)) continue
    seen.add(t.id)
    const side = t.buyerId === youId ? 'buy' : t.sellerId === youId ? 'sell' : null
    if (!side) continue
    const notice = bySide.get(side)
    if (notice) {
      notice.qty += t.qty
      notice.total += t.qty * t.price
      notice.trades += 1
    } else {
      bySide.set(side, { key: t.id, side, qty: t.qty, total: t.qty * t.price, avgPrice: 0, trades: 1 })
    }
  }
  return [...bySide.values()].map((n) => ({
    ...n,
    qty: r1(n.qty),
    total: r1(n.total),
    avgPrice: r1(n.total / n.qty),
  }))
}

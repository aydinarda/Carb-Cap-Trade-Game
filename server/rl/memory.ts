// COPY of rl/memory.ts. The RL training kit lives in the local, git-ignored rl/ folder; keep the two
// identical. Every model file carries the feature list it was trained on, and server/rl/models.ts
// refuses to run a model whose list differs from what this copy builds.

import { announcements } from '../../shared/announcements'
import type { PlayerSettlement, PlayerSnapshot } from '../../shared/types'

/**
 * What the agent remembers between snapshots — and ONLY from snapshots it was actually sent.
 *
 * The player screen keeps nothing between pushes, so the snapshot alone would leave the agent
 * knowing less than a student, who remembers last year's prices and their own results. This
 * is that memory, and nothing more: every field here was on the agent's own screen at some
 * earlier moment. It never reads the session.
 */

/** How many settled years are kept. Enough for the 1–3 year VWAP ratios. */
export const MEMORY_YEARS = 4

export interface YearMemory {
  year: number
  /** The year's VWAP, as the year-summary screen's market showed it. */
  vwap: number | null
  auctionPrice: number | null
  settlement: PlayerSettlement | null
  realized: number | null
  netPosition: number | null
  points: number | null
  /** 1 = first among the companies that have points. */
  rank: number | null
  /** How many companies had points — the denominator for `rank`. */
  n: number | null
  tradingGap: number | null
  investmentGap: number | null
  classMedianPoints: number | null
  classRealized: number | null
}

export interface Memory {
  /** The round the agent first saw — `years_elapsed` counts from here. */
  firstYear: number | null
  /** The company's last pre-game emission, read off the history chart on first sight. */
  baseline: number | null
  /** Settled years, most recent first, at most `MEMORY_YEARS`. */
  years: YearMemory[]
  /** The first market price seen in the current round. */
  yearOpenPrice: number | null
  /** The market price at the previous decision, and at this one. */
  prevDecisionPrice: number | null
  curDecisionPrice: number | null
  priceYear: number | null
  /** How many rounds the rate-cut headline has been on screen. The message does not say
   *  how long it lasts, but a student can count the rounds it has been up. */
  ratesSeenRounds: number
  ratesSeenYear: number | null
}

export function createMemory(): Memory {
  return {
    firstYear: null,
    baseline: null,
    years: [],
    yearOpenPrice: null,
    prevDecisionPrice: null,
    curDecisionPrice: null,
    priceYear: null,
    ratesSeenRounds: 0,
    ratesSeenYear: null,
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Fold one snapshot into memory. Call it for every snapshot the agent receives, BEFORE
 * observing it — decision snapshots and the year-summary screen alike.
 */
export function remember(mem: Memory, snap: PlayerSnapshot): void {
  const year = snap.currentYear

  if (mem.firstYear === null) {
    mem.firstYear = year
    const before = Object.keys(snap.you.emissions)
      .map(Number)
      .filter((y) => y < year)
    mem.baseline = before.length ? (snap.you.emissions[Math.max(...before)] ?? null) : null
  }

  const rates = announcements(snap).find((a) => a.key === 'rates')
  if (!rates || rates.state === 'past') {
    mem.ratesSeenRounds = 0
    mem.ratesSeenYear = null
  } else if (mem.ratesSeenYear !== year) {
    mem.ratesSeenRounds += 1
    mem.ratesSeenYear = year
  }

  // The year-summary screen: what a student reads once the round has settled.
  if (snap.phase === 'yearSummary' || snap.phase === 'ended') {
    if (mem.years[0]?.year === year) return
    const emitters = (snap.leaderboard ?? []).filter((row) => row.points !== null)
    const index = emitters.findIndex((row) => row.id === snap.you.id)
    const own = index === -1 ? null : emitters[index]
    mem.years.unshift({
      year,
      vwap: snap.market?.vwap ?? null,
      auctionPrice: snap.auctionPrice,
      settlement: snap.you.settlement,
      realized: snap.you.realized,
      netPosition: snap.you.netPosition,
      points: own?.points ?? null,
      rank: own ? index + 1 : null,
      n: own ? emitters.length : null,
      tradingGap: own?.tradingGap ?? null,
      investmentGap: own?.investmentGap ?? null,
      classMedianPoints: median(emitters.map((row) => row.points as number)),
      classRealized: snap.classAggregate?.totalRealized ?? null,
    })
    if (mem.years.length > MEMORY_YEARS) mem.years.length = MEMORY_YEARS
    return
  }

  // A decision snapshot: track the price path within the round.
  if (mem.priceYear !== year) {
    mem.priceYear = year
    mem.yearOpenPrice = null
    mem.prevDecisionPrice = null
    mem.curDecisionPrice = null
  }
  const price = snap.market?.lastPrice ?? null
  if (mem.yearOpenPrice === null && price !== null) mem.yearOpenPrice = price
  mem.prevDecisionPrice = mem.curDecisionPrice
  mem.curDecisionPrice = price
}

import type { ReserveConfig } from '../config/schema'
import { round1 } from './rng'

/**
 * Cost containment reserve — the ladder, as pure arithmetic.
 *
 * Deliberately free of `Session`, RNG and the phase machine, so the mechanism can be proven
 * on its own before any of it is wired to the order book.
 *
 * The shape: a finite pot, and a set of rungs. Each rung names a market price and the
 * CUMULATIVE share of the pot that may have been released once that price is reached. So a
 * ladder of 8/13/19/25% releases 8% at the first rung, then 5% more, then 6%, then 6% — the
 * increments fall out of the cumulative ceilings rather than being listed separately.
 */

/**
 * What the pot is a share of.
 *
 * `shortfall` is zero whenever issuance already meets need — which is exactly the case under
 * auctioning at `auctionCapRatio >= 1`. A zero base means a zero pot means an inert reserve,
 * and that is the correct answer: a cost containment reserve exists to relieve scarcity, and
 * there is none to relieve. It is not a wiring bug, and the simulator says so out loud.
 */
export function reserveBase(cfg: ReserveConfig, totalExpected: number, issuance: number): number {
  const base = cfg.basis === 'need' ? totalExpected : totalExpected - issuance
  return round1(Math.max(0, base))
}

/** The whole pot: the last rung's cumulative fraction of the base. */
export function reservePot(cfg: ReserveConfig, base: number): number {
  const last = cfg.steps[cfg.steps.length - 1]
  return last ? round1(base * last.cumulativeFraction) : 0
}

/**
 * What to offer right now, given the market price and how much is already committed
 * (released plus still resting unsold).
 *
 * Returns one entry per newly unlocked rung — NOT one lump at the highest. A price that jumps
 * straight from €50 to €85 posts four separate offers at 55/62/70/80, so the ladder is
 * visible in the book and each rung is its own soft ceiling.
 *
 * Idempotent, and that is the hysteresis: call it again at the same price with the same
 * `committed` and it returns nothing. A price oscillating 56 → 54 → 56 releases nothing the
 * second time, because `committed` already covers the first rung's ceiling. This only holds
 * because `committed` counts offered as well as sold — counting only fills would re-post an
 * unfilled rung on every single order.
 */
/**
 * This round's repeating top-up, or nothing.
 *
 * Separate from `plannedRelease` because it is a different rule: the ladder is a one-way
 * ratchet measured against everything released so far, while this is a fixed slice offered
 * afresh each round for as long as the price stays high. Mixing them into one `committed`
 * running total would let the ladder's ceiling swallow the top-up, or the top-up exhaust the
 * ladder — the two must not share an accumulator.
 */
export function plannedRecurring(
  cfg: ReserveConfig,
  base: number,
  marketPrice: number,
): { price: number; qty: number }[] {
  if (!cfg.enabled || base <= 0) return []
  const rec = cfg.recurring
  if (!rec?.offers?.length || marketPrice < rec.fromPrice) return []
  return rec.offers
    .map((o) => ({ price: o.price, qty: round1(base * o.fraction) }))
    .filter((o) => o.qty > 0)
}

/**
 * The most rungs of the open-ended ladder offered in one round: 110 … 1,100 € at the shipped
 * step. A safety bound, not a design top — one print at an absurd price must not make the
 * reserve post thousands of orders.
 */
export const OPEN_LADDER_MAX_RUNGS = 100

/**
 * The open-ended ladder above the fine (`reserve.openLadder`): the rungs the price has newly
 * reached this round.
 *
 * Rung k sits at `fromPrice + k × step` and offers `(fraction + k × increment) × issuance` at
 * that price, at most the whole issuance: the higher the price, the more is offered.
 * `offered` is how many rungs this round has already posted, so each is offered once a round
 * and a price that jumps straight from 100 to 135 posts 110, 120 and 130 as three orders.
 *
 * It takes the year's ISSUANCE, not the pot's base: this ladder is outside the pot and is
 * offered in a year whose pot is 0 too.
 */
export function plannedOpenLadder(
  cfg: ReserveConfig,
  issuance: number,
  marketPrice: number,
  offered: number,
): { price: number; qty: number }[] {
  const ladder = cfg.openLadder
  // Not `cfg.enabled`: that is the host's switch for the pot, and the ladder above the fine
  // keeps running when it is off (2026-11-16). `fraction` 0 is this ladder's own off switch.
  if (!(ladder.fraction > 0) || !(ladder.step > 0) || !(issuance > 0)) return []
  if (marketPrice < ladder.fromPrice) return []
  // The first rung is the smallest: if even that rounds to nothing, there is no ladder.
  if (round1(issuance * ladder.fraction) <= 0) return []
  const increment = Math.max(0, ladder.increment)
  const reached = Math.min(
    OPEN_LADDER_MAX_RUNGS,
    Math.floor((marketPrice - ladder.fromPrice) / ladder.step + 1e-9) + 1,
  )
  const out: { price: number; qty: number }[] = []
  for (let k = Math.max(0, offered); k < reached; k++) {
    out.push({
      price: round1(ladder.fromPrice + k * ladder.step),
      qty: round1(issuance * Math.min(1, ladder.fraction + k * increment)),
    })
  }
  return out
}

export function plannedRelease(
  cfg: ReserveConfig,
  base: number,
  marketPrice: number,
  committed: number,
): { price: number; qty: number }[] {
  if (!cfg.enabled || base <= 0) return []
  const out: { price: number; qty: number }[] = []
  let covered = Math.max(0, committed)
  for (const step of cfg.steps) {
    if (marketPrice < step.triggerPrice) break // rungs ascend, so nothing above is unlocked
    const ceiling = base * step.cumulativeFraction
    const qty = round1(ceiling - covered)
    if (qty > 0) out.push({ price: step.triggerPrice, qty })
    covered = Math.max(covered, ceiling)
  }
  return out
}

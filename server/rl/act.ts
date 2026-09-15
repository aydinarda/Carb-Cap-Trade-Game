// COPY of rl/act.ts. The RL training kit lives in the local, git-ignored rl/ folder; keep the two
// identical. Every model file carries the feature list it was trained on, and server/rl/models.ts
// refuses to run a model whose list differs from what this copy builds.

import { GameError, type Session } from '../session'
import type { PlayerSnapshot } from '../../shared/types'
import { heldCredits, type StepKind } from './observe'

/**
 * Turns the policy's four numbers into what a student would click, and submits it through
 * the same Session methods the socket handlers call.
 *
 * Sizes and prices are computed from the SNAPSHOT — the numbers on the agent's screen — so the
 * agent cannot size an order off something it was never shown. Only the submission touches
 * the session.
 *
 *   a0  abatement: how far toward this round's ceiling to install (≤ 0 = nothing)
 *   a1  side: < −⅓ sell, > ⅓ buy, otherwise no order
 *   a2  size: 0 … 1.5 × the shortfall (never less than 5% of planned emissions as the base)
 *   a3  price: reference × e^(0.5·a3), clipped to [0.5, 2 × penalty]
 */
export type Intent =
  | { kind: 'bid'; qty: number; price: number }
  | { kind: 'trade'; side: 'buy' | 'sell' | null; qty: number; price: number }
  | { kind: 'abate'; from: number; target: number }

const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
const round1 = (x: number) => Math.round(x * 10) / 10

export function decode(action: readonly number[], snap: PlayerSnapshot, kind: StepKind): Intent {
  const a = [0, 1, 2, 3].map((i) => {
    const v = Number(action[i])
    return Number.isFinite(v) ? clip(v, -1, 1) : 0
  })
  const you = snap.you
  const P = snap.penaltyRate > 0 ? snap.penaltyRate : 100
  const planned = you.plannedEmission
  const gap = planned - heldCredits(snap)
  const reference = snap.market?.lastPrice ?? snap.market?.vwap ?? snap.prevMarketPrice ?? 0.5 * P
  const price = round1(clip(reference * Math.exp(0.5 * a[3]), 0.5, 2 * P))
  const size = (base: number) => round1(((a[2] + 1) / 2) * 1.5 * Math.max(base, 0.05 * planned))

  if (kind === 'bid') return { kind, qty: size(gap), price }

  if (kind === 'abate') {
    const from = you.abatementCommitted
    const room = Math.max(0, snap.abatementRoundCeiling - from)
    // Two decimals, as `Session.setAbatement` stores it.
    const target = Math.round((from + Math.max(0, a[0]) * room) * 100) / 100
    return { kind, from, target }
  }

  const side = a[1] < -1 / 3 ? 'sell' : a[1] > 1 / 3 ? 'buy' : null
  let qty = size(Math.abs(gap))
  // Own asks are cancelled before placing, so everything held is offerable — no shorting.
  if (side === 'sell') qty = Math.min(qty, Math.max(0, round1(you.creditsHeld ?? 0)))
  return { kind, side, qty, price }
}

/** Submits an intent. A rule the engine refuses (wrong phase, no shorting) is not an error. */
export function apply(session: Session, playerId: string, intent: Intent): { rejected: boolean } {
  try {
    if (intent.kind === 'bid') {
      if (intent.qty > 0) session.submitBid(playerId, intent.qty, intent.price)
    } else if (intent.kind === 'abate') {
      if (intent.target > intent.from) session.setAbatement(playerId, intent.target)
    } else {
      // Every decision starts from a clean book, so the state the agent reasons about is
      // the one it sees rather than orders it placed several decisions ago.
      const mine = (session.currentYearRecord()?.orders ?? [])
        .filter((o) => o.playerId === playerId && o.status === 'open')
        .map((o) => o.id)
      for (const id of mine) session.cancelOrder(playerId, id)
      if (intent.side && intent.qty > 0) session.placeOrder(playerId, intent.side, intent.qty, intent.price)
    }
    return { rejected: false }
  } catch (error) {
    if (!(error instanceof GameError)) throw error
    return { rejected: true }
  }
}

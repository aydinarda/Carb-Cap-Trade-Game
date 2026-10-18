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
 *   a1  side: < −⅓ sell, > ⅓ buy, otherwise no order; at the abatement step, for a model that
 *       decides it (feature set 2), > 0 keeps "borrow from next year's share" selected
 *   a2  size: 0 … 1.5 × the shortfall (never less than 5% of planned emissions as the base)
 *   a3  price: reference × e^(0.5·a3), clipped to [0.5, 2 × penalty]
 *
 * The numbers in that table are `DEFAULT_DECODE`. A trained version may carry its own — they
 * are part of what the policy learned against, so a model is only ever decoded with the
 * parameters it was trained with.
 */
export interface DecodeParams {
  /** a1 beyond ±this picks a side; inside it, no order. */
  sideThreshold: number
  /** Order size at a2 = +1, as a multiple of the shortfall. */
  sizeScale: number
  /** Floor on the shortfall sizing is based on, as a share of planned emissions. */
  sizeFloor: number
  /** a3 = ±1 prices e^(±priceSpread) around the reference. */
  priceSpread: number
  /** Lowest price quoted, in euros. */
  priceFloor: number
  /** Highest price quoted, as a multiple of the penalty rate. */
  priceCap: number
}

export const DEFAULT_DECODE: DecodeParams = {
  sideThreshold: 1 / 3,
  sizeScale: 1.5,
  sizeFloor: 0.05,
  priceSpread: 0.5,
  priceFloor: 0.5,
  priceCap: 2,
}

/** Fills in defaults and refuses anything unknown or out of range — the values arrive as JSON. */
export function resolveDecode(partial: Partial<DecodeParams> | undefined): DecodeParams {
  const unknown = Object.keys(partial ?? {}).filter((k) => !(k in DEFAULT_DECODE))
  if (unknown.length) throw new Error(`decode: unknown parameter ${unknown.join(', ')}`)
  const p = { ...DEFAULT_DECODE, ...partial }
  if (!(p.sideThreshold >= 0 && p.sideThreshold < 1)) throw new Error('decode.sideThreshold must be in [0, 1)')
  if (!(p.sizeScale > 0) || !(p.sizeFloor >= 0)) throw new Error('decode.sizeScale must be > 0 and sizeFloor ≥ 0')
  if (!(p.priceSpread > 0)) throw new Error('decode.priceSpread must be > 0')
  if (!(p.priceFloor > 0) || !(p.priceCap > 0)) throw new Error('decode.priceFloor and priceCap must be > 0')
  return p
}

/** Whether these are exactly the parameters every shipped model and the live server decode with. */
export const isDefaultDecode = (p: DecodeParams) =>
  (Object.keys(DEFAULT_DECODE) as (keyof DecodeParams)[]).every((k) => p[k] === DEFAULT_DECODE[k])

/**
 * Who decides "cover a shortfall from next year's share": the policy itself (`'action'`: a1 > 0
 * at the abatement step keeps it selected), or nobody — it stays selected, as it starts every
 * year, which is how bots play it and how every model trained before feature set 2 is run.
 */
export type BorrowMode = 'action' | 'always'

export type Intent =
  | { kind: 'bid'; qty: number; price: number }
  | { kind: 'trade'; side: 'buy' | 'sell' | null; qty: number; price: number }
  | { kind: 'abate'; from: number; target: number; borrow?: boolean }

const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
const round1 = (x: number) => Math.round(x * 10) / 10

export function decode(
  action: readonly number[],
  snap: PlayerSnapshot,
  kind: StepKind,
  params: DecodeParams = DEFAULT_DECODE,
  borrow: BorrowMode = 'always',
): Intent {
  const a = [0, 1, 2, 3].map((i) => {
    const v = Number(action[i])
    return Number.isFinite(v) ? clip(v, -1, 1) : 0
  })
  const you = snap.you
  const P = snap.penaltyRate > 0 ? snap.penaltyRate : 100
  const planned = you.plannedEmission
  const gap = planned - heldCredits(snap)
  const reference = snap.market?.lastPrice ?? snap.market?.vwap ?? snap.prevMarketPrice ?? 0.5 * P
  const price = round1(clip(reference * Math.exp(params.priceSpread * a[3]), params.priceFloor, params.priceCap * P))
  const size = (base: number) =>
    round1(((a[2] + 1) / 2) * params.sizeScale * Math.max(base, params.sizeFloor * planned))

  if (kind === 'bid') return { kind, qty: size(gap), price }

  if (kind === 'abate') {
    const from = you.abatementCommitted
    const room = Math.max(0, snap.abatementRoundCeiling - from)
    // Two decimals, as `Session.setAbatement` stores it.
    const target = Math.round((from + Math.max(0, a[0]) * room) * 100) / 100
    // The abatement step is the last of the year before it settles, and a1 has no other use
    // here — so that is where the borrowing choice lives.
    if (borrow === 'action' && you.borrow) return { kind, from, target, borrow: a[1] > 0 }
    return { kind, from, target }
  }

  const side = a[1] < -params.sideThreshold ? 'sell' : a[1] > params.sideThreshold ? 'buy' : null
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
      if (intent.borrow !== undefined && session.borrowOptedIn(playerId) !== intent.borrow) {
        session.setBorrowOptIn(playerId, intent.borrow)
      }
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

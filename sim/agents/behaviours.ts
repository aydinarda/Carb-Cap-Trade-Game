import {
  buildMarketView,
  expectedEmission,
  marginalCost,
  optimalAbatement,
  round1,
  type Rng,
} from '../../shared/engine'
import { GameError, type Session } from '../../server/session'
import { priceCeiling } from '../../server/bots/helpers'
import type { Player } from '../../shared/types'

/**
 * Simulated students.
 *
 * These are NOT `Player.botType` bots — they drive ordinary human-shaped players through
 * exactly the methods a socket would call (`setAbatement`, `placeOrder`, `submitBid`), so
 * every engine invariant (phase gating, no shorting) is genuinely exercised. The point is
 * to model how people actually play rather than how a textbook firm would: the market's
 * behaviour depends far more on the mix of these than on the liquidity bots.
 */
export type Behaviour = 'passive' | 'rational' | 'hedger' | 'opportunist'

export const BEHAVIOURS: Behaviour[] = ['passive', 'rational', 'hedger', 'opportunist']

export interface BehaviourTraits {
  /** Chance of acting at all on a given tick — nobody clicks every round. */
  participation: number
  /** Fraction of its residual position it tries to close in one go. */
  urgency: number
  /** Multiplier on the cover target: 1 = exactly cover, >1 = over-hedge. */
  coverTarget: number
  /** Multiplier on the cost-minimising abatement fraction. */
  abatementBias: number
  /** Multiplier on its bid/ask price relative to perceived fair value. */
  priceBias: number
  /** σ of per-tick price noise. */
  priceNoise: number
}

export const BEHAVIOUR_TRAITS: Record<Behaviour, BehaviourTraits> = {
  // Never cuts, barely trades, absorbs the penalty. Pure inelastic demand — the archetype
  // that makes a tight cap bite.
  passive: {
    participation: 0.15,
    urgency: 0.3,
    coverTarget: 0.4,
    abatementBias: 0,
    priceBias: 0.9,
    priceNoise: 0.15,
  },
  // Plays the textbook: abate to r*, cover the residual near fair value.
  rational: {
    participation: 0.85,
    urgency: 0.7,
    coverTarget: 1,
    abatementBias: 1,
    priceBias: 1,
    priceNoise: 0.05,
  },
  // Risk-averse: over-covers and over-abates, and pays up to be safe early.
  hedger: {
    participation: 0.8,
    urgency: 0.9,
    coverTarget: 1.15,
    abatementBias: 1.25,
    priceBias: 1.1,
    priceNoise: 0.07,
  },
  // Waits for a cheap price, under-covers, then scrambles at the close.
  opportunist: {
    participation: 0.6,
    urgency: 0.45,
    coverTarget: 0.85,
    abatementBias: 0.7,
    priceBias: 0.85,
    priceNoise: 0.18,
  },
}

export interface AgentState {
  playerId: string
  behaviour: Behaviour
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** How far through the trade window we are (0..1) — drives late-round urgency. */
export interface TickContext {
  progress: number
  isLastTick: boolean
}

/**
 * One trade-stage tick for one simulated student. Returns whether it acted.
 */
export function actTrade(
  session: Session,
  agent: AgentState,
  rng: Rng,
  tick: TickContext,
): boolean {
  const record = session.currentYearRecord()
  if (!record) return false
  const player = session.getPlayer(agent.playerId)
  if (!player) return false
  const t = BEHAVIOUR_TRAITS[agent.behaviour]

  // The opportunist stops waiting once the window is nearly over — the late demand spike
  // is exactly the behaviour that tests whether the book is deep enough to absorb it.
  const panicking = agent.behaviour === 'opportunist' && tick.progress > 0.75
  if (!panicking && rng.next() > t.participation) return false

  const cfg = session.state.config
  const P = priceCeiling(session)
  const spec = cfg.abatement.sectors[player.industry]
  const mv = buildMarketView(record.orders, record.trades)
  const reference = mv.lastPrice ?? mv.vwap ?? session.openingReference()

  // Abate toward the market-implied optimum, scaled by how keen this archetype is to cut.
  // Keenness scales the optimum, but nothing gets past the plant's physical ceiling.
  const rStar = clamp(
    optimalAbatement(spec, reference) * t.abatementBias, 0, session.maxAbatement,
  )
  try {
    session.setAbatement(agent.playerId, rStar)
  } catch (e) {
    if (!(e instanceof GameError)) throw e
  }

  const expected = expectedEmission(player, record.year)
  const held = session.creditsHeld(agent.playerId)
  const need = expected * (1 - rStar) * t.coverTarget - held

  const fair = Math.min(P, marginalCost(rStar, spec))
  const noise = rng.normal(0, t.priceNoise)
  const bias = panicking ? Math.max(t.priceBias, 1.15) : t.priceBias
  const price = round1(clamp(fair * (bias + noise), cfg.bots.minPrice, P))
  const qty = round1(Math.abs(need) * (panicking ? 1 : t.urgency))
  if (qty <= 0.5) return false

  try {
    if (need > 0) {
      session.placeOrder(agent.playerId, 'buy', qty, price)
    } else {
      const capacity = session.creditsHeld(agent.playerId)
      if (capacity <= 0) return false
      session.placeOrder(agent.playerId, 'sell', Math.min(qty, capacity), price)
    }
    return true
  } catch (e) {
    // Rejections (no shorting, wrong phase) are legitimate outcomes, not sim failures —
    // a real student mis-clicks too.
    if (!(e instanceof GameError)) throw e
    return false
  }
}

/** Cap-stage sealed bid, for modes that run a primary auction. */
export function actAuction(session: Session, agent: AgentState, rng: Rng): boolean {
  const record = session.currentYearRecord()
  if (!record) return false
  const player = session.getPlayer(agent.playerId)
  if (!player) return false
  const t = BEHAVIOUR_TRAITS[agent.behaviour]

  const cfg = session.state.config
  const P = priceCeiling(session)
  const spec = cfg.abatement.sectors[player.industry]
  const reference = session.openingReference()
  // Keenness scales the optimum, but nothing gets past the plant's physical ceiling.
  const rStar = clamp(
    optimalAbatement(spec, reference) * t.abatementBias, 0, session.maxAbatement,
  )
  const expected = expectedEmission(player, record.year)
  const qty = round1(expected * (1 - rStar) * t.coverTarget - session.creditsHeld(agent.playerId))
  if (qty <= 0) return false

  const price = round1(
    clamp(reference * (t.priceBias + rng.normal(0, t.priceNoise)), cfg.bots.minPrice, P),
  )
  try {
    session.submitBid(agent.playerId, qty, price)
    return true
  } catch (e) {
    if (!(e instanceof GameError)) throw e
    return false
  }
}

/** Deterministically assigns behaviours to a population from a proportional mix. */
export function allocateMix<T extends string>(mix: Partial<Record<T, number>>, count: number): T[] {
  const entries = Object.entries(mix).filter(([, w]) => (w as number) > 0) as [T, number][]
  if (entries.length === 0) throw new Error('mix must have at least one positive weight')
  const total = entries.reduce((s, [, w]) => s + w, 0)

  // Largest-remainder apportionment, so a 30/70 split of 10 players is exactly 3/7 and
  // never drifts with the seed.
  const raw = entries.map(([k, w]) => ({ k, exact: (w / total) * count }))
  const out: T[] = []
  for (const { k, exact } of raw) for (let i = 0; i < Math.floor(exact); i++) out.push(k)
  const remainders = raw
    .map(({ k, exact }) => ({ k, rem: exact - Math.floor(exact) }))
    .sort((a, b) => b.rem - a.rem)
  let i = 0
  while (out.length < count) out.push(remainders[i++ % remainders.length].k)
  return out.slice(0, count)
}

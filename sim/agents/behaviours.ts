import {
  buildMarketView,
  marginalCost,
  optimalAbatement,
  round1,
  type Rng,
} from '../../shared/engine'
import { GameError, type Session } from '../../server/session'
import { considerInstall, priceCeiling } from '../../server/bots/helpers'

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
  /**
   * How dear this archetype acts as though carbon were, when deciding whether to install
   * capacity. 0 never invests; 1.25 behaves as if the price were 25% above the market.
   *
   * It multiplies the *price* fed to `planInstall` rather than the resulting fraction,
   * because the decision is no longer a fraction — it is "is this retrofit worth its fee
   * over the horizon?", and only a price enters that. A keener firm is one that expects
   * carbon to get dearer, which is also the more honest story.
   */
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
  /**
   * Ephemeral, mirroring `BotRuntime.lastInvestYear`: one install decision a year, because
   * each step pays the retrofit fee again and these agents tick many times a window.
   */
  rt?: { lastInvestYear?: number }
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** Where in the GAME this year sits. Separate from the within-year tick context because
 *  the two drive different decisions: the tick drives urgency, the year drives whether
 *  holding a surplus is worth anything at all. */
export interface YearContext {
  /** 0-based index of this year within the run. */
  index: number
  /** How many years the run has in total — the agents are told, exactly as a class is. */
  total: number
}

/** How far through the trade window we are (0..1) — drives late-round urgency. */
export interface TickContext {
  progress: number
  isLastTick: boolean
  year: YearContext
}

/**
 * The cover target this archetype actually plays this year.
 *
 * `coverTarget > 1` is over-hedging: buy more than you need, carry the surplus. That used to
 * be free — `endGame` cashed leftover allowances out at the final market price, so a hedger
 * got its money back. It no longer does: **a leftover surplus is stranded and worth nothing**
 * (see `Session.endGame`), while a leftover debt is still settled in full.
 *
 * So the incentive reverses at the end of the game, and an agent that ignored that would be
 * modelling a player who had not read the rules. The taper is deliberately gradual rather
 * than a final-year cliff: a surplus bought in year 9 of 10 is nearly as stranded as one
 * bought in year 10, because there is only one more market to sell it into.
 *
 * Under-covering (`coverTarget < 1`) is left alone — the debt side did not change.
 */
function effectiveCoverTarget(base: number, year: YearContext): number {
  if (base <= 1) return base
  const remaining = year.total - year.index // 1 in the final year
  if (remaining >= 3) return base
  // 2 years left → half the over-hedge; final year → none of it.
  const keep = remaining <= 1 ? 0 : 0.5
  return 1 + (base - 1) * keep
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

  // Whether to buy abatement capacity — a once-a-year capital decision that changes
  // NOTHING about this year's position, and so is kept well away from the sizing below.
  // Capacity bought in the final year never switches on, so nobody buys it then.
  agent.rt ??= {}
  if (tick.year.index < tick.year.total - 1) {
    considerInstall(session, agent.playerId, agent.rt, reference, t.abatementBias)
  }

  // `lifetimeCap` is NOT optional here. Without it `optimalAbatement` returns the
  // unconstrained optimum, which at any price above `a + b` is a 100% cut — a cut the engine
  // forbids (`Session.setAbatement` clamps to the cap). The agent then valued carbon at
  // `MAC(1) = a + b` (85/120/125/190 by sector) instead of at the dearest cut it is actually
  // allowed, `MAC(cap) = a + cap·b` (47.5/70/75/115 at cap 0.5). Since `fair` is capped at the
  // fine, every sector's fair value collapsed onto the fine itself — which is why the market
  // printed at the ceiling and looked anchored by the penalty rather than by fundamentals.
  const rStar = optimalAbatement(spec, reference, cfg.abatement.lifetimeCap)
  const planned = session.plannedEmission(agent.playerId)
  const held = session.creditsHeld(agent.playerId)
  const need = planned * effectiveCoverTarget(t.coverTarget, tick.year) - held

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
export function actAuction(
  session: Session,
  agent: AgentState,
  rng: Rng,
  year: YearContext,
): boolean {
  const record = session.currentYearRecord()
  if (!record) return false
  const player = session.getPlayer(agent.playerId)
  if (!player) return false
  const t = BEHAVIOUR_TRAITS[agent.behaviour]

  const cfg = session.state.config
  const P = priceCeiling(session)
  const reference = session.openingReference()
  // Capacity bought now would not arrive until next year, so it cannot shrink what this
  // year's auction has to cover. The install decision belongs to the trade stage.
  const planned = session.plannedEmission(agent.playerId)
  const qty = round1(
    planned * effectiveCoverTarget(t.coverTarget, year) - session.creditsHeld(agent.playerId),
  )
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

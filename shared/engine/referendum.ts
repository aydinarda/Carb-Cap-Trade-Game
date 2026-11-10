import type { GameState, Player, Referendum, ReferendumResult, VoteChoice } from '../types'
import { createRng } from './rng'
import { isPureTrader } from './roles'

/**
 * The borrowing referendum's arithmetic, kept pure so the session, the bots, the RL agents and
 * the training world all count and vote by the same rules.
 */

/** Whether a company has a vote: anyone with emissions. Pure-trader bots have neither. */
export function canVote(player: Player): boolean {
  return !isPureTrader(player)
}

/**
 * A company's average borrowing as a share of its emission: tonnes covered from next year's
 * share over tonnes emitted, averaged over the settled years borrowing was on in. Null with no
 * such year yet.
 */
export function averageBorrowShare(state: GameState, playerId: string): number | null {
  let sum = 0
  let n = 0
  for (const record of Object.values(state.years)) {
    const realized = record.realized[playerId]
    if (!record.borrowed || realized === undefined || !(realized > 0)) continue
    sum += (record.borrowed[playerId] ?? 0) / realized
    n++
  }
  return n > 0 ? sum / n : null
}

/** The rule a company that does not vote by hand is voted for by; see `market.referendum`. */
export interface VoteRule {
  /** The proposed cap, × emission. */
  frac: number
  weights: { borrowing: number; abatement: number }
  /** Installed abatement at which the abatement lean is even. */
  abatementPivot: number
}

/**
 * The abatement part's lean toward yes, in [0, 1]: 0 with nothing installed, ½ at the pivot,
 * 1 at full capacity, linear on each side (the user's rule, 2026-11-10: from the pivot up it
 * leans to yes, below it to no, in proportion).
 */
export function abatementLean(installed: number, pivot: number): number {
  const a = Math.min(1, Math.max(0, installed))
  return a <= pivot ? (0.5 * a) / pivot : 0.5 + (0.5 * (a - pivot)) / (1 - pivot)
}

/**
 * The chance the rule votes yes on capping borrowing at `rule.frac` × emission. Two parts,
 * weighted (normalised) by `rule.weights`:
 *  - borrowing (the user's rule, 2026-11-01): 0 if the company has been borrowing more than the
 *    cap on average — the cap would bind it — else 1, history or not;
 *  - abatement (2026-11-10): `abatementLean` of its installed capacity (`abatementCommitted`).
 */
export function ruleYesProbability(state: GameState, playerId: string, rule: VoteRule): number {
  const average = averageBorrowShare(state, playerId)
  const borrowingYes = average !== null && average > rule.frac ? 0 : 1
  const installed = state.players.find((p) => p.id === playerId)?.abatementCommitted ?? 0
  const lean = abatementLean(installed, rule.abatementPivot)
  const { borrowing, abatement } = rule.weights
  return (borrowing * borrowingYes + abatement * lean) / (borrowing + abatement)
}

/**
 * A uniform draw in [0, 1) fixed by the game's seed, the referendum and the company. It does not
 * touch the session's own stream and does not depend on the order the votes come in, so holding
 * a referendum never moves another number and a seeded game replays its votes.
 */
export function voteDraw(seed: number, referendumId: number, playerId: string): number {
  let h = 0x811c9dc5 // FNV-1a
  for (const ch of `${seed}:${referendumId}:${playerId}`) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193)
  }
  return createRng(h >>> 0).next()
}

/** How a bot, a simulated student or an RL agent votes: yes when `draw` < `ruleYesProbability`. */
export function ruleVote(state: GameState, playerId: string, rule: VoteRule, draw: number): VoteChoice {
  return draw < ruleYesProbability(state, playerId, rule) ? 'yes' : 'no'
}

/** The count over the companies that could vote: a simple majority of the votes cast; a tie fails. */
export function tally(referendum: Referendum, eligible: readonly string[]): ReferendumResult {
  let yes = 0
  let no = 0
  for (const id of eligible) {
    const vote = referendum.votes[id]
    if (vote === 'yes') yes++
    else if (vote === 'no') no++
  }
  return { approved: yes > no, yes, no, eligible: eligible.length }
}

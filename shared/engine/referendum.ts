import type { GameState, Player, Referendum, ReferendumResult, VoteChoice } from '../types'
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

/**
 * How a bot, a simulated student or an RL agent votes on capping borrowing at `frac` × its
 * emission (the user's rule, 2026-11-01): against it if it has been borrowing more than that on
 * average — the cap would bind it — and for it otherwise, history or not.
 */
export function ruleVote(state: GameState, playerId: string, frac: number): VoteChoice {
  const average = averageBorrowShare(state, playerId)
  return average !== null && average > frac ? 'no' : 'yes'
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

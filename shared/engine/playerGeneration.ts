import { INDUSTRIES } from '../constants'
import type { PlayerProfile } from '../types'
import { round1, type Rng } from './rng'

/**
 * Generates a 10-year emission history for a chosen industry per the notebook:
 *   latest = U(industry range)
 *   oldest = latest × (1 + U(0.05, 0.2))
 *   trend  = linspace(oldest, latest, 10) + N(0, 0.03·latest), rounded to 1 dp
 *   emissions[i] is stored to Year_{10−i}
 *
 * OQ-1: the notebook maps the FIRST linspace element (the oldest, largest value)
 * to Year_10 while also treating Year_10 as the baseline year. Implemented
 * verbatim; intent to be confirmed with the game designer.
 *
 * The notebook assigns industries randomly (25% each); in the game students pick
 * their own industry at join, so only the history generation lives here.
 */
export function generateHistoryForIndustry(
  industry: keyof typeof INDUSTRIES,
  rng: Rng,
): PlayerProfile {
  const { low, high } = INDUSTRIES[industry]

  const latest = rng.uniform(low, high)
  const reduction = rng.uniform(0.05, 0.2)
  const oldest = latest * (1 + reduction)

  const emissions: Record<number, number> = {}
  for (let i = 0; i < 10; i++) {
    const trend = oldest + ((latest - oldest) * i) / 9
    const noise = rng.normal(0, 0.03 * latest)
    emissions[10 - i] = round1(trend + noise)
  }

  return { industry, emissions }
}

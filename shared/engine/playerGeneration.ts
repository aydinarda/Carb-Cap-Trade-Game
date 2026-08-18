import { DEFAULT_GAME_CONFIG } from '../config/defaults'
import type { EmissionsConfig } from '../config/schema'
import type { Industry } from '../constants'
import type { PlayerProfile } from '../types'
import { round1, type Rng } from './rng'

/**
 * Generates a pre-game emission history for a chosen industry per the notebook:
 *   latest = U(industry range)
 *   oldest = latest × (1 + U(declineLow, declineHigh))
 *   trend  = linspace(oldest, latest, historyYears) + N(0, trendNoise·latest), 1 dp
 *   emissions[i] is stored to Year_{historyYears−i}
 *
 * OQ-1: the notebook maps the FIRST linspace element (the oldest, largest value)
 * to Year_10 while also treating Year_10 as the baseline year. Implemented
 * verbatim; intent to be confirmed with the game designer.
 *
 * The notebook assigns industries randomly (25% each); in the game students pick
 * their own industry at join, so only the history generation lives here.
 *
 * The order and count of `rng` draws is load-bearing: it fixes every seeded history in
 * the game and in the golden test. Do not reorder them or add a draw in between.
 */
export function generateHistoryForIndustry(
  industry: Industry,
  rng: Rng,
  config: EmissionsConfig = DEFAULT_GAME_CONFIG.emissions,
): PlayerProfile {
  const { low, high } = config.industries[industry]
  const { declineLow, declineHigh, trendNoise } = config.generation
  const years = config.historyYears

  const latest = rng.uniform(low, high)
  const reduction = rng.uniform(declineLow, declineHigh)
  const oldest = latest * (1 + reduction)

  const emissions: Record<number, number> = {}
  for (let i = 0; i < years; i++) {
    const trend = oldest + ((latest - oldest) * i) / (years - 1)
    const noise = rng.normal(0, trendNoise * latest)
    emissions[years - i] = round1(trend + noise)
  }

  return { industry, emissions }
}

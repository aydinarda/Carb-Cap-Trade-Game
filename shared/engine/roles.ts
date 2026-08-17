import type { Player, PublicPlayerInfo } from '../types'

/**
 * Pure-trader bots (market makers, speculators) are financial intermediaries, not
 * installations: they carry ~0 emissions and exist only to provide liquidity. They
 * get no free allocation (they have no activity level to benchmark against), and
 * the skill-vs-optimum leaderboard metric is meaningless for them.
 */
export function isPureTrader(player: Player | PublicPlayerInfo): boolean {
  return !!player.isBot && (player.botType === 'marketMaker' || player.botType === 'speculator')
}

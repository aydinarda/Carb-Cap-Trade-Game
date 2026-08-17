import type { CapMode } from '../types'
import { auctioning } from './auctioning'
import { benchmarking } from './benchmarking'
import type { CapMechanism } from './capMechanism'
import { grandfathering } from './grandfathering'

export const CAP_MECHANISMS: Record<CapMode, CapMechanism> = {
  grandfathering,
  benchmarking,
  auctioning,
}

export { type CapMechanism } from './capMechanism'
export { realizeYear, expectedEmission } from './emissions'
export { abatementCost, optimalAbatement, optimalYearCost } from './abatement'
export { generateHistoryForIndustry } from './playerGeneration'
export { createRng, round1, type Rng } from './rng'
export { isPureTrader } from './roles'
export { computeNetPositions } from './trade'
export { windowSum, computeFreeCreditLimit } from './grandfathering'
export { benchmarkFor } from './benchmarking'
export { clearAuction } from './auction'
export {
  matchOrder,
  cancelOrder,
  tradedNet,
  tradedCash,
  openSellRemaining,
  buildMarketView,
} from './orderBook'
export { settleYear } from './settlement'

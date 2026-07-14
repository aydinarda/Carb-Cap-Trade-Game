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

export { MechanismNotImplementedError, type CapMechanism } from './capMechanism'
export { realizeYear } from './emissions'
export { generateHistoryForIndustry, generatePlayerProfile } from './playerGeneration'
export { createRng, round1, type Rng } from './rng'
export { computeNetPositions } from './trade'
export { windowSum, computeFreeCreditLimit } from './grandfathering'
export {
  buildMarketView,
  cancelOrder,
  matchOrder,
  openSellRemaining,
  tradedNet,
} from './orderBook'
export { grantRegulator } from './regulator'
export { settleYear } from './settlement'

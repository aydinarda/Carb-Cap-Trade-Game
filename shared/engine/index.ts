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
export {
  abatementCost,
  marginalCost,
  optimalAbatement,
  optimalYearCost,
  toSpec,
  parseSpec,
  type AbatementCoeff,
  type AbatementInput,
  type AbatementSpec,
} from './abatement'
export {
  ABATEMENT_MODELS,
  bisectOptimal,
  bisectSpec,
  specIntegral,
  specMarginal,
  specOptimal,
  type AbatementModel,
  type AbatementModelId,
  type AbatementParamsByModel,
  type AbatementTier,
} from './abatementModels'
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
  tradedNetAll,
  tradedCash,
  openSellRemaining,
  meanOfLast,
  buildMarketView,
} from './orderBook'
export { settleYear } from './settlement'
export { plannedRelease, reserveBase, reservePot } from './reserve'

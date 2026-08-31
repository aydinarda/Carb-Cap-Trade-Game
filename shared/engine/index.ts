import type { CapMode } from '../types'
import { auctioning } from './auctioning'
import { benchmarking } from './benchmarking'
import type { CapMechanism } from './capMechanism'
import { grandfathering } from './grandfathering'
import { hybrid } from './hybrid'

export const CAP_MECHANISMS: Record<CapMode, CapMechanism> = {
  grandfathering,
  benchmarking,
  auctioning,
  hybrid,
}

export { type CapMechanism } from './capMechanism'
export { realizeYear, expectedEmission } from './emissions'
export {
  abatementCost,
  incrementalFraction,
  installCost,
  installValue,
  investmentGap,
  marginalCost,
  optimalAbatement,
  optimalYearCost,
  planInstall,
  toSpec,
  parseSpec,
  unabatedFrom,
  type AbatementCoeff,
  type AbatementInput,
  type AbatementSpec,
  type InstallPlan,
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
export { hybridFreeFor } from './hybrid'
export { clearAuction } from './auction'
export {
  matchOrder,
  cancelOrder,
  tradedNet,
  tradedNetAll,
  tradedCash,
  openSellRemaining,
  meanOfLast,
  vwapOfLast,
  buildMarketView,
} from './orderBook'
export { settleYear } from './settlement'
export { plannedRecurring, plannedRelease, reserveBase, reservePot } from './reserve'

export { cumulativeCapFactor } from './capReduction'

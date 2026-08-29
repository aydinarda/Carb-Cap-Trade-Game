import { INDUSTRY_NAMES } from '../constants'
import { ABATEMENT_MODELS, parseSpec } from '../engine/abatementModels'
import { DEFAULT_GAME_CONFIG } from './defaults'
import type { GameConfig } from './schema'

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Recursive merge of an override onto a base.
 *
 * Two properties matter here and are covered by tests:
 *  - **Always clones.** `Session.updateSettings` mutates `config.allocation.benchmark[i]`
 *    in place. If a resolved config aliased `DEFAULT_GAME_CONFIG`, one classroom's host
 *    edit would leak into every other live session AND into the module default.
 *  - **Arrays are replaced wholesale**, never merged element-wise. Merging a 3-band
 *    tiered abatement curve onto a 4-band default would silently produce a curve that
 *    is neither.
 *
 * `Record<Industry, …>` maps are plain objects, so they merge key by key — overriding
 * one sector's benchmark leaves the other three at their defaults.
 */
export function deepMerge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (over === undefined) return structuredClone(base)
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over) as T
  const out = structuredClone(base) as Record<string, unknown>
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : structuredClone(value)
  }
  return out as T
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const positive = (v: number, path: string) => {
  if (!Number.isFinite(v) || v < 0) throw new ConfigError(`${path} must be a non-negative number.`)
}

/**
 * Range checks for a fully-resolved config.
 *
 * `Session.updateSettings` keeps its own equivalent checks for the five host-editable
 * knobs: those produce user-facing `GameError` messages that the UI surfaces and the
 * tests pin, whereas this guards scenario overrides written in code.
 */
export function validateConfig(config: GameConfig): GameConfig {
  positive(config.market.penaltyRate, 'market.penaltyRate')
  positive(config.market.openingReferenceFraction, 'market.openingReferenceFraction')
  positive(config.allocation.auctionCapRatio, 'allocation.auctionCapRatio')
  positive(config.allocation.freeCreditRatio, 'allocation.freeCreditRatio')

  const lrf = config.allocation.capReductionFactor
  if (!Number.isFinite(lrf) || lrf <= 0 || lrf > 1) {
    throw new ConfigError('allocation.capReductionFactor must be in (0, 1].')
  }
  // 0 = unlimited; anything negative is a mistake.
  if (config.session.maxPlayers < 0) throw new ConfigError('session.maxPlayers must be >= 0.')
  if (config.emissions.historyYears < 2) {
    // The generator interpolates across historyYears − 1 gaps.
    throw new ConfigError('emissions.historyYears must be >= 2.')
  }
  positive(config.emissions.volatility, 'emissions.volatility')

  for (const industry of INDUSTRY_NAMES) {
    positive(config.allocation.benchmark[industry], `allocation.benchmark.${industry}`)
    const { low, high } = config.emissions.industries[industry]
    if (!(high >= low) || low < 0) {
      throw new ConfigError(`emissions.industries.${industry} must satisfy 0 <= low <= high.`)
    }
  }
  const cap = config.abatement.lifetimeCap
  if (!Number.isFinite(cap) || cap < 0 || cap > 1) {
    throw new ConfigError('abatement.lifetimeCap must be in [0, 1].')
  }
  positive(config.abatement.fixedCostPerTonneBaseline, 'abatement.fixedCostPerTonneBaseline')
  const horizon = config.abatement.investmentHorizon
  if (!Number.isFinite(horizon) || horizon <= 0) {
    throw new ConfigError('abatement.investmentHorizon must be > 0.')
  }

  const reserve = config.allocation.reserve
  if (reserve.triggerTrades < 1) {
    throw new ConfigError('allocation.reserve.triggerTrades must be >= 1.')
  }
  if (reserve.basis !== 'shortfall' && reserve.basis !== 'need') {
    throw new ConfigError("allocation.reserve.basis must be 'shortfall' or 'need'.")
  }
  if (reserve.enabled && reserve.steps.length === 0) {
    throw new ConfigError('allocation.reserve.steps must be non-empty when enabled.')
  }
  // Strictly increasing in BOTH fields: the ladder's whole meaning is that a higher price
  // unlocks strictly more supply at a strictly higher offer.
  let prevPrice = -Infinity
  let prevFrac = 0
  reserve.steps.forEach((step, i) => {
    positive(step.triggerPrice, `allocation.reserve.steps[${i}].triggerPrice`)
    if (step.triggerPrice <= prevPrice) {
      throw new ConfigError(`allocation.reserve.steps[${i}].triggerPrice must ascend.`)
    }
    if (!(step.cumulativeFraction > prevFrac) || step.cumulativeFraction > 1) {
      throw new ConfigError(
        `allocation.reserve.steps[${i}].cumulativeFraction must ascend and stay <= 1.`,
      )
    }
    prevPrice = step.triggerPrice
    prevFrac = step.cumulativeFraction
  })

  return config
}

/**
 * Builds a complete config from an optional override.
 *
 * The abatement pass exists because a discriminated union cannot be merged naively:
 * `{ model: 'tiered' }` laid over `{ model: 'linear', params: { a, b } }` would otherwise
 * yield a `tiered` spec still carrying linear params, and those `NaN` costs would flow
 * all the way through settlement into every score.
 */
export function resolveConfig(over?: DeepPartial<GameConfig>): GameConfig {
  const config = deepMerge(DEFAULT_GAME_CONFIG, over)

  for (const industry of INDUSTRY_NAMES) {
    const override = over?.abatement?.sectors?.[industry]
    const base = DEFAULT_GAME_CONFIG.abatement.sectors[industry]
    if (override?.model && override.model !== base.model) {
      // Model changed: params come from the override, or from the new model's own
      // defaults — never inherited from the model being replaced.
      config.abatement.sectors[industry] = parseSpec({
        model: override.model,
        params: override.params ?? ABATEMENT_MODELS[override.model].defaults,
      })
    } else {
      config.abatement.sectors[industry] = parseSpec(config.abatement.sectors[industry])
    }
  }

  // Setting the scalar factor MEANS a flat factor.
  //
  // The shipped config carries a decelerating `capReductionSchedule`, and a schedule wins
  // over the scalar wherever both exist — so without this, a scenario that overrode
  // `capReductionFactor` would silently get the schedule instead and its arm would measure
  // nothing. Five tests caught it; a sweep would not have.
  //
  // A caller that wants both sets both. A caller that sets only the factor is asking for the
  // old, flat behaviour and gets it.
  if (
    over?.allocation?.capReductionFactor !== undefined &&
    over?.allocation?.capReductionSchedule === undefined
  ) {
    config.allocation.capReductionSchedule = []
  }

  return validateConfig(config)
}

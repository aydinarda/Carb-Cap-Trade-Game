export type {
  AbatementConfig,
  AllocationConfig,
  BotsConfig,
  EmissionsConfig,
  GameConfig,
  MarketConfig,
  MarketMakerConfig,
  SessionLimits,
} from './schema'
export { DEFAULT_GAME_CONFIG } from './defaults'
export { deepMerge, resolveConfig, validateConfig, type DeepPartial } from './merge'

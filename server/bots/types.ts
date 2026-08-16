import type { Rng } from '../../shared/engine'
import type { BotType, Player } from '../../shared/types'
import type { Session } from '../session'

export type { BotType }

/** How often the bot driver wakes (ms). Human-paced — bots never out-click a person. */
export const BOT_TICK_MS = 2500

// --- Market maker ---
export const MM_MIN_MARGIN = 0.5 // absolute floor on the half-spread / profit margin
export const MM_SPREAD_FRAC = 0.06 // half-spread as a fraction of perceived value
export const MM_SKEW = 0.008 // price shift per unit of inventory deviation from target
export const MM_SKEW_CAP_FRAC = 0.4 // skew is clamped to ±(this × penaltyRate)
export const MM_INV_FRAC = 0.18 // auction target inventory = this × auction supply
export const MM_AUCTION_PRICE_FRAC = 0.9 // auction bid price = this × penaltyRate (aggressive)
export const MM_QUOTE_SIZE = 15 // resting quote size each side

// --- Speculator (momentum) ---
export const SPEC_SIZE = 10
export const SPEC_INIT_INV = 20 // inventory bought at auction to have something to sell
export const MOM_EPS = 0.01 // price move fraction that triggers a momentum trade

// --- Noise (compliance-like objective, noisy execution, small size) ---
export const NOISE_SIZE = 4 // small base order size
export const NOISE_ERR = 0.25 // chance to flip side / mangle price
export const NOISE_SKIP = 0.2 // chance to do nothing this tick
export const NOISE_PRICE_JITTER = 0.25 // ±fraction on price

/** Per-order quantity cap so bots work positions gradually (human pacing). */
export const MAX_STEP = 40

/** Ephemeral per-bot runtime, kept in the BotManager — never serialized into GameState. */
export interface BotRuntime {
  lastSeenPrice?: number
}

/** Everything an archetype's advance() needs. */
export interface BotCtx {
  session: Session
  bot: Player
  rng: Rng
  rt: BotRuntime
}

import type { CapMechanism } from './capMechanism'
import { MechanismNotImplementedError } from './capMechanism'
import { computeFreeCreditLimit } from './grandfathering'

/**
 * Auctioning (STUB — details pending from the game designer).
 *
 * Per the notebook: "no free credits. Purely auction-based." The auction format
 * (sealed bid? uniform price? rounds?) is not yet specified, so `allocate`
 * throws rather than silently returning all-zeros — the auction itself would
 * replace the cap-stage decision flow, not just the allocation numbers.
 */
export const auctioning: CapMechanism = {
  mode: 'auctioning',
  implemented: false,
  computeFreeCreditLimit,
  allocate() {
    throw new MechanismNotImplementedError('auctioning')
  },
}

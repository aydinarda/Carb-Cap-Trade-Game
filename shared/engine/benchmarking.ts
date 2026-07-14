import type { CapMechanism } from './capMechanism'
import { MechanismNotImplementedError } from './capMechanism'
import { computeFreeCreditLimit } from './grandfathering'

/**
 * Benchmarking (STUB — details pending from the game designer).
 *
 * Per the notebook: "an emission parameter is assigned to the industry, and the
 * number of free credits is the production quantities times the emission
 * parameter." Production quantities and the per-industry benchmark parameters
 * are not yet specified.
 */
export const benchmarking: CapMechanism = {
  mode: 'benchmarking',
  implemented: false,
  computeFreeCreditLimit,
  allocate() {
    throw new MechanismNotImplementedError('benchmarking')
  },
}

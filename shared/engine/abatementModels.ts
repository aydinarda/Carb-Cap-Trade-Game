/**
 * Marginal abatement cost (MAC) curves.
 *
 * A company's cost to cut the f-th fraction of its emissions is `marginal(f)` per tonne.
 * Every curve here must be **non-decreasing in f** — cheap cuts first — because both the
 * bots' reservation pricing and the "optimal cut is where MAC meets the price" pedagogy
 * depend on it.
 *
 * `linear` is the model the game has always used; the others exist so a scenario can ask
 * what happens when cutting is much dearer at the margin, without touching the engine.
 */

export type AbatementModelId = 'linear' | 'power' | 'exponential' | 'tiered'

export interface AbatementTier {
  /** Upper bound of this band, as a fraction of emissions. Ascending; the last is 1. */
  upTo: number
  /** Flat cost per tonne within the band. Non-decreasing across bands. */
  rate: number
}

export interface AbatementParamsByModel {
  /** MAC = a + b·f — the original model. */
  linear: { a: number; b: number }
  /** MAC = a + b·fⁿ — n = 1 is exactly `linear`; n > 1 back-loads the expense. */
  power: { a: number; b: number; n: number }
  /** MAC = a·e^(k·f) — a constant proportional steepening; the expensive multiplier. */
  exponential: { a: number; k: number }
  /** Piecewise-constant MAC: a cheap tranche, then a cliff. */
  tiered: { tiers: AbatementTier[] }
}

/** Discriminated union — how models with different parameter shapes stay type-safe. */
export type AbatementSpec = {
  [K in AbatementModelId]: { model: K; params: AbatementParamsByModel[K] }
}[AbatementModelId]

export interface AbatementModel<P> {
  readonly id: AbatementModelId
  /** MAC at fraction f — cost of the next tonne, per tonne. NEVER rounded: the bots
   *  price off this, and rounding would shift every quote by up to half a tick. */
  marginal(f: number, p: P): number
  /** ∫₀ʳ marginal(f) df — total cost per unit of expected emission. Unrounded. */
  integral(r: number, p: P): number
  /** Closed-form argwhere marginal = price, clamped to [0,1]. Omit to use bisection. */
  optimal?(price: number, p: P): number
  /** Narrows an unknown override (scenario or host payload) or throws. */
  parse(raw: unknown): P
  readonly defaults: P
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

const num = (v: unknown, name: string, { min = -Infinity } = {}): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
    throw new Error(`abatement: ${name} must be a finite number >= ${min}, got ${String(v)}`)
  }
  return v
}

const obj = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null) throw new Error('abatement: params must be an object')
  return raw as Record<string, unknown>
}

/**
 * Generic solver for any model that does not publish a closed form. Relies on `marginal`
 * being non-decreasing. Not used by the four shipped models — they all have exact
 * inverses — but it means a fifth model only has to implement `marginal` and `integral`.
 */
export function bisectOptimal<P>(model: AbatementModel<P>, params: P, price: number): number {
  if (model.marginal(0, params) >= price) return 0
  if (model.marginal(1, params) <= price) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2
    if (model.marginal(mid, params) < price) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const linear: AbatementModel<AbatementParamsByModel['linear']> = {
  id: 'linear',
  defaults: { a: 4, b: 20 },
  marginal: (f, { a, b }) => a + b * f,
  integral: (r, { a, b }) => a * r + (b * r * r) / 2,
  // Preserved verbatim from the original implementation, b <= 0 branch included.
  optimal: (price, { a, b }) => (b <= 0 ? (price > a ? 1 : 0) : clamp01((price - a) / b)),
  parse: (raw) => {
    const o = obj(raw)
    return { a: num(o.a, 'a', { min: 0 }), b: num(o.b, 'b', { min: 0 }) }
  },
}

const power: AbatementModel<AbatementParamsByModel['power']> = {
  id: 'power',
  defaults: { a: 4, b: 20, n: 2 },
  marginal: (f, { a, b, n }) => a + b * Math.pow(f, n),
  integral: (r, { a, b, n }) => a * r + (b * Math.pow(r, n + 1)) / (n + 1),
  optimal: (price, { a, b, n }) => {
    if (b <= 0 || n <= 0) return price > a ? 1 : 0
    // Guard before the fractional power — a negative base would give NaN.
    if (price <= a) return 0
    return clamp01(Math.pow((price - a) / b, 1 / n))
  },
  parse: (raw) => {
    const o = obj(raw)
    return {
      a: num(o.a, 'a', { min: 0 }),
      b: num(o.b, 'b', { min: 0 }),
      n: num(o.n, 'n', { min: 0 }),
    }
  },
}

const exponential: AbatementModel<AbatementParamsByModel['exponential']> = {
  id: 'exponential',
  defaults: { a: 3, k: 2.5 },
  marginal: (f, { a, k }) => a * Math.exp(k * f),
  integral: (r, { a, k }) =>
    // The k → 0 limit is a·r; without the guard this is 0/0.
    Math.abs(k) < 1e-9 ? a * r : (a / k) * (Math.exp(k * r) - 1),
  optimal: (price, { a, k }) => {
    if (a <= 0) return 1
    if (k <= 0) return price > a ? 1 : 0
    if (price <= a) return 0
    return clamp01(Math.log(price / a) / k)
  },
  parse: (raw) => {
    const o = obj(raw)
    return { a: num(o.a, 'a', { min: 0 }), k: num(o.k, 'k', { min: 0 }) }
  },
}

const tiered: AbatementModel<AbatementParamsByModel['tiered']> = {
  id: 'tiered',
  defaults: {
    tiers: [
      { upTo: 0.3, rate: 5 },
      { upTo: 0.6, rate: 18 },
      { upTo: 1, rate: 60 },
    ],
  },
  marginal: (f, { tiers }) => (tiers.find((t) => f < t.upTo) ?? tiers[tiers.length - 1]).rate,
  integral: (r, { tiers }) => {
    let total = 0
    let prev = 0
    for (const t of tiers) {
      total += t.rate * Math.max(0, Math.min(r, t.upTo) - prev)
      prev = t.upTo
    }
    return total
  },
  // The MAC is a step function, so the cost-minimising cut always lands on a band
  // boundary. Bisecting a discontinuity would return boundary ± ε and make the bots
  // jitter, so this walks the bands instead.
  optimal: (price, { tiers }) => {
    let cut = 0
    for (const t of tiers) {
      if (t.rate > price) break
      cut = t.upTo
    }
    return clamp01(cut)
  },
  parse: (raw) => {
    const o = obj(raw)
    if (!Array.isArray(o.tiers) || o.tiers.length === 0) {
      throw new Error('abatement: tiered.tiers must be a non-empty array')
    }
    let prevUpTo = 0
    let prevRate = -Infinity
    const tiers = o.tiers.map((t, i) => {
      const e = obj(t)
      const upTo = num(e.upTo, `tiers[${i}].upTo`, { min: 0 })
      const rate = num(e.rate, `tiers[${i}].rate`, { min: 0 })
      if (upTo <= prevUpTo) throw new Error(`abatement: tiers[${i}].upTo must ascend`)
      if (rate < prevRate) throw new Error(`abatement: tiers[${i}].rate must not decrease`)
      prevUpTo = upTo
      prevRate = rate
      return { upTo, rate }
    })
    if (tiers[tiers.length - 1].upTo !== 1) {
      throw new Error('abatement: the last tier must have upTo === 1')
    }
    return { tiers }
  },
}

export const ABATEMENT_MODELS = { linear, power, exponential, tiered } as const

// The union dispatch lives here so callers never switch on `model` themselves.
// Each case narrows `spec`, so `params` is correctly typed per branch.

/** MAC at fraction `f`. Unrounded. */
export function specMarginal(f: number, spec: AbatementSpec): number {
  const r = clamp01(f)
  switch (spec.model) {
    case 'linear':
      return linear.marginal(r, spec.params)
    case 'power':
      return power.marginal(r, spec.params)
    case 'exponential':
      return exponential.marginal(r, spec.params)
    case 'tiered':
      return tiered.marginal(r, spec.params)
  }
}

/** Total cost per unit of expected emission to abate fraction `r`. Unrounded. */
export function specIntegral(r: number, spec: AbatementSpec): number {
  const x = clamp01(r)
  switch (spec.model) {
    case 'linear':
      return linear.integral(x, spec.params)
    case 'power':
      return power.integral(x, spec.params)
    case 'exponential':
      return exponential.integral(x, spec.params)
    case 'tiered':
      return tiered.integral(x, spec.params)
  }
}

/** Cost-minimising abatement fraction at `price`, clamped to [0,1]. */
export function specOptimal(price: number, spec: AbatementSpec): number {
  switch (spec.model) {
    case 'linear':
      return linear.optimal!(price, spec.params)
    case 'power':
      return power.optimal!(price, spec.params)
    case 'exponential':
      return exponential.optimal!(price, spec.params)
    case 'tiered':
      return tiered.optimal!(price, spec.params)
  }
}

/**
 * Numeric optimum for a spec, via bisection rather than the closed form. This is the
 * path a future model without an exact inverse would take, and it doubles as the
 * cross-check that the shipped closed forms are right.
 */
export function bisectSpec(price: number, spec: AbatementSpec): number {
  switch (spec.model) {
    case 'linear':
      return bisectOptimal(linear, spec.params, price)
    case 'power':
      return bisectOptimal(power, spec.params, price)
    case 'exponential':
      return bisectOptimal(exponential, spec.params, price)
    case 'tiered':
      return bisectOptimal(tiered, spec.params, price)
  }
}

/** Validates and normalizes an arbitrary spec-shaped value. Throws on a bad shape. */
export function parseSpec(raw: unknown): AbatementSpec {
  const o = obj(raw)
  const model = o.model
  if (typeof model !== 'string' || !(model in ABATEMENT_MODELS)) {
    throw new Error(`abatement: unknown model ${String(model)}`)
  }
  const id = model as AbatementModelId
  switch (id) {
    case 'linear':
      return { model: id, params: linear.parse(o.params) }
    case 'power':
      return { model: id, params: power.parse(o.params) }
    case 'exponential':
      return { model: id, params: exponential.parse(o.params) }
    case 'tiered':
      return { model: id, params: tiered.parse(o.params) }
  }
}

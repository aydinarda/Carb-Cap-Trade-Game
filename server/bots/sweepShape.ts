/**
 * How a bot spreads its auction quantity over the steps of its sweep (`bots.sweep`).
 *
 * A bot's bid price is an estimate: the market has landed ~22% (median) away from the auction
 * reference in simulated games. So instead of betting its whole quantity on one price, the bot
 * puts on each step the probability that the step's price is the right one. The steps sit one
 * σ apart around the bid price; each step's quantity is the probability mass of a distribution
 * of that error over the step's bin (midpoints between steps, the outer bins open-ended).
 *
 *   'normal'  a skew-normal, standardised to mean 0 and sd 1, so its shape `skew` (α) moves
 *             WHERE the quantity sits, not the average price the bot pays — that is the bid
 *             price's job. α = 0 is the plain normal: 6.7 / 24.2 / 38.3 / 24.2 / 6.7 % over five
 *             steps. α > 0 leaves a thin tail at higher prices (insurance for a firm that must
 *             cover: being short costs the fine, being long only banks), α < 0 a tail at lower
 *             prices (a bargain tranche for a trader whose risk is overpaying). The simulated
 *             misses are right-skewed (skewness 0.3–2.7 by mode), which is what the insurance tail
 *             answers.
 *   'even'    the same quantity on every step.
 */

const SQRT2PI = Math.sqrt(2 * Math.PI)

/** Standard normal density. */
const phi = (x: number) => Math.exp(-0.5 * x * x) / SQRT2PI

/** Standard normal CDF, via the Abramowitz–Stegun 7.1.26 error function (|error| < 1.5e-7). */
function Phi(x: number): number {
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z)
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

/** Density of the skew-normal with shape α, standardised to mean 0 and standard deviation 1. */
function skewNormalPdf(x: number, alpha: number): number {
  const delta = alpha / Math.sqrt(1 + alpha * alpha)
  const omega = 1 / Math.sqrt(1 - (2 * delta * delta) / Math.PI)
  const xi = -omega * delta * Math.sqrt(2 / Math.PI)
  const z = (x - xi) / omega
  return (2 / omega) * phi(z) * Phi(alpha * z)
}

const cache = new Map<string, number[]>()

/**
 * The share of the quantity on each of `n` steps, lowest price first. The steps sit at z = k −
 * (n − 1)/2 standard deviations from the bid price; the shares add up to 1.
 */
export function sweepWeights(n: number, shape: 'normal' | 'even', skew: number): number[] {
  if (n <= 1) return [1]
  if (shape === 'even') return Array.from({ length: n }, () => 1 / n)
  const key = `${n}|${skew}`
  const hit = cache.get(key)
  if (hit) return hit
  const centre = (n - 1) / 2
  // Upper bin edges, lowest step first; the last bin runs to +∞ (here: +10 sd).
  const edges = Array.from({ length: n }, (_, i) => (i === n - 1 ? 10 : i - centre + 0.5))
  // Simpson's rule from −10 sd, accumulated bin by bin.
  const mass: number[] = []
  let from = -10
  for (const to of edges) {
    const steps = Math.max(2, Math.ceil((to - from) / 0.01) & ~1)
    const h = (to - from) / steps
    let sum = skewNormalPdf(from, skew) + skewNormalPdf(to, skew)
    for (let j = 1; j < steps; j++) sum += (j % 2 ? 4 : 2) * skewNormalPdf(from + j * h, skew)
    mass.push((sum * h) / 3)
    from = to
  }
  const total = mass.reduce((a, b) => a + b, 0)
  const weights = mass.map((m) => m / total)
  cache.set(key, weights)
  return weights
}

/**
 * 'coverFirst' placement: the shares of the extra (banking) quantity over the `n − 1` steps below
 * the old bid, nearest first — a half-normal two steps wide, so the bot asks for less the further
 * the price falls but still bids something on every step (≈ 55 / 24 / 13 / 8 % over four). One
 * step wide would leave the cheapest step ~0.05%, which rounds away.
 */
export function bankWeights(n: number): number[] {
  if (n <= 1) return []
  // Bins [0, 1.5), [1.5, 2.5), … steps below the bid, measured in units of the half-normal's
  // width (two steps); the last bin is open.
  const k = n - 1
  const width = 2
  const edges = Array.from({ length: k }, (_, i) => (i === k - 1 ? Infinity : (i + 1.5) / width))
  let prev = 0
  const mass = edges.map((e) => {
    const cdf = e === Infinity ? 1 : 2 * Phi(e) - 1
    const m = cdf - prev
    prev = cdf
    return m
  })
  const total = mass.reduce((a, b) => a + b, 0)
  return mass.map((m) => m / total)
}

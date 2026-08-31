/**
 * The game's sector table and every formula behind it, printed from the CONFIG IN FORCE.
 *
 *     pnpm ref              # everything
 *     pnpm ref -- sectors   # just the sector table
 *     pnpm ref -- formulas  # just the formulas
 *     pnpm ref -- --price 80 --year 14    # sector table at another price / round
 *
 * Computed, never transcribed. Three separate places in this app had hand-written copies of
 * config numbers that had silently drifted — a panel still quoting an 80% free-credit ratio
 * that shipped at 100%, an auction described as a "fixed price" sale, and a lobby telling
 * every class its ten-year history set its free credits. A reference sheet is exactly the
 * kind of document that goes stale that way, so this one derives every figure from
 * `DEFAULT_GAME_CONFIG` and the same engine functions the game settles with.
 */
import { DEFAULT_GAME_CONFIG as C } from '../shared/config'
import { INDUSTRY_NAMES, SECTOR_AVERAGE_EMISSIONS, type Industry } from '../shared/constants'
import {
  abatementCost,
  cumulativeCapFactor,
  installCost,
  marginalCost,
  optimalAbatement,
} from '../shared/engine'

const args = process.argv.slice(2)
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback
}
const want = (section: string) => {
  const named = args.filter((a) => !a.startsWith('--') && !/^\d/.test(a))
  return named.length === 0 || named.includes(section)
}

const PRICE = flag('price', 60)
const YEAR = flag('year', C.emissions.firstGameYear)
const r1 = (n: number) => Math.round(n * 10) / 10
const pad = (s: string | number, n: number) => String(s).padStart(n)

const rule = (title: string) => {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
  console.log('─'.repeat(78))
}

// ── sectors ──────────────────────────────────────────────────────────────────
if (want('sectors')) {
  rule(`SECTORS   (carbon price €${PRICE}/t · round ${YEAR})`)

  const lrf = cumulativeCapFactor(C, YEAR)
  console.log(
    `cap reduction in force this round: ×${lrf.toFixed(3)}` +
      `   (round 1 = ×1.000, no reduction applies to the opening allocation)\n`,
  )

  console.log(
    'sector'.padEnd(26) +
      pad('emission', 10) + pad('avg', 7) + pad('bench', 8) +
      pad('free%', 7) + pad('free cr', 9) + '   MAC a + b·f',
  )
  for (const i of INDUSTRY_NAMES) {
    const { low, high } = C.emissions.industries[i]
    const avg = SECTOR_AVERAGE_EMISSIONS[i]
    const bench = C.allocation.benchmark[i]
    const share = C.allocation.hybridFreeShare[i]
    const spec = C.abatement.sectors[i]
    const p = spec.model === 'linear' ? (spec.params as { a: number; b: number }) : null
    console.log(
      i.padEnd(26) +
        pad(`${low}-${high}`, 10) + pad(avg, 7) + pad(r1(bench * lrf), 8) +
        pad(`${Math.round(share * 100)}%`, 7) + pad(r1(bench * share * lrf), 9) +
        (p ? `   a=${pad(p.a, 3)}  b=${pad(p.b, 4)}` : `   ${spec.model}`),
    )
  }

  console.log(
    `\n  emission   the range a company's generated history is drawn from (tCO2/yr)` +
      `\n  bench      sector benchmark this round = benchmark table × cap reduction` +
      `\n  free%      hybrid mode only: the share of that benchmark issued free` +
      `\n  free cr    what that share is actually worth this round` +
      `\n  MAC        marginal abatement cost of the f-th fraction, in €/t`,
  )

  rule(`ABATEMENT ECONOMICS   (at €${PRICE}/t, lifetime cap ${C.abatement.lifetimeCap})`)
  console.log(
    'sector'.padEnd(26) +
      pad('1st t', 8) + pad('last t', 8) + pad('r*(P)', 8) +
      pad('MAC(r*)', 9) + pad('€ to r*', 10) + pad('fee/step', 10) + pad('€ to cap', 10),
  )
  for (const i of INDUSTRY_NAMES) {
    const spec = C.abatement.sectors[i]
    const avg = SECTOR_AVERAGE_EMISSIONS[i]
    const cap = C.abatement.lifetimeCap
    const rStar = optimalAbatement(spec, PRICE, cap)
    const fee = C.abatement.fixedCostPerTonneBaseline * avg
    console.log(
      i.padEnd(26) +
        pad(r1(marginalCost(0, spec)), 8) +
        pad(r1(marginalCost(1, spec)), 8) +
        pad(rStar.toFixed(2), 8) +
        pad(r1(marginalCost(rStar, spec)), 9) +
        pad(Math.round(abatementCost(avg, rStar, spec)), 10) +
        pad(Math.round(fee), 10) +
        pad(Math.round(installCost(avg, 0, cap, spec, fee)), 10),
    )
  }
  console.log(
    `\n  1st t / last t   MAC at f=0 and f=1 — the cheapest and dearest tonne` +
      `\n  r*(P)            cost-minimising cut at this price: (P − a)/b, capped at the lifetime cap` +
      `\n  MAC(r*)          what the marginal tonne costs there — equals P unless the cap binds` +
      `\n  € to r*          variable cost of cutting to r*, for an average company in the sector` +
      `\n  fee/step         retrofit fee, charged AGAIN on every install step` +
      `\n  € to cap         one-move cost of going straight to the lifetime cap, fee included` +
      `\n\n  A sector whose MAC(r*) is BELOW the price has hit the lifetime cap: no price buys it` +
      `\n  a deeper cut, so it must cover the rest on the market. That asymmetry is the point —` +
      `\n  power decarbonises cheaply, cement and steel cannot.`,
  )
}

// ── formulas ─────────────────────────────────────────────────────────────────
if (want('formulas')) {
  const a = C.allocation
  const m = C.market
  const s = C.scoring

  rule('ALLOCATION   how many allowances exist, and who is handed them')
  console.log(`  LRF(y)  = product of the per-round factors up to round y`)
  console.log(`            schedule ${JSON.stringify(a.capReductionSchedule.map((x) => [x.fromRound, x.factor]))}`)
  console.log(`            fallback flat factor ${a.capReductionFactor} where no schedule applies`)
  console.log(`            round 1 is the baseline the schedule shrinks FROM, so LRF(1) = 1\n`)
  console.log(`  grandfathering   free_i = (window_i / Σwindow) × ${a.freeCreditRatio} × Σbaseline × LRF(y)`)
  console.log(`                   window_i = company i's own emissions over the last ${C.emissions.historyWindow} years`)
  console.log(`                   pool   = 0                        (no primary sale)`)
  console.log(`  benchmarking     free_i = benchmark[sector_i] × LRF(y)`)
  console.log(`                   pool   = 0`)
  console.log(`  auctioning       free_i = 0`)
  console.log(`                   pool   = ${a.auctionCapRatio} × Σbaseline × LRF(y)`)
  console.log(`  hybrid           free_i = benchmark[sector_i] × hybridFreeShare[sector_i] × LRF(y)`)
  console.log(`                   cap    = ${a.auctionCapRatio} × Σbaseline × LRF(y)`)
  console.log(`                   pool   = max(0, cap − Σfree)      ← free comes OUT of the auction`)
  console.log(`\n  Σbaseline is the class total of year ${C.emissions.baselineYear} emissions.`)

  rule('AUCTION   single round, sealed bid, uniform price')
  console.log(`  bids sorted by price, filled until the pool runs out`)
  console.log(`  clearing price = the lowest ACCEPTED bid — every winner pays that one price`)
  console.log(`  ties at the margin share the remainder pro-rata`)
  console.log(`  reserve  = ${a.auctionReserveFrac} × reference price   (nothing sells below it)`)
  console.log(`  undersubscribed → everyone above the reserve fills, and the price IS the reserve`)

  rule('ABATEMENT   permanent capacity, one year late')
  console.log(`  MAC(f)        = a + b·f                    €/t of the f-th fraction`)
  console.log(`  total(E, r)   = E × (a·r + b·r²/2)         cost of cutting a fraction r`)
  console.log(`  r*(P)         = (P − a)/b                  clamped to [0, ${C.abatement.lifetimeCap}]`)
  console.log(`  install f→t   = fee + E × (∫₀ᵗ − ∫₀ᶠ)      fee = ${C.abatement.fixedCostPerTonneBaseline} × baseline, EVERY step`)
  console.log(`\n  Capacity bought in year y cuts emissions from year y+1. It is permanent and`)
  console.log(`  cannot be sold or reversed. Stepping costs one extra fee per step, so 10% then`)
  console.log(`  40% is dearer than 50% in one move by exactly one fee — the variable halves are`)
  console.log(`  identical because the integral is additive.`)

  rule('EMISSIONS   what you actually emit')
  console.log(`  planned_y  = last realized × (1 − new capacity in force)`)
  console.log(`  realized_y ~ Normal(planned_y, ${C.emissions.volatility} × planned_y)`)
  console.log(`\n  Drawn at YEAR END, after the market closes. You commit your cover before you`)
  console.log(`  know it — which is why holding a buffer is rational, not waste.`)

  rule('SETTLEMENT   the money')
  console.log(`  held       = free + auction award + carry-in + net traded`)
  console.log(`  shortage   = max(0, realized − held)`)
  console.log(`  yearCost   = abatement spend + purchases − sale income + shortage × ${m.penaltyRate}`)
  console.log(`  carry      = held − realized        surplus banks (+), shortfall becomes debt (−)`)
  console.log(`\n  The fine is NOT a price ceiling: an uncovered tonne is fined AND still owed, so`)
  console.log(`  defaulting costs the fine plus buying that tonne later. At game end a leftover`)
  console.log(`  surplus is stranded worthless; a leftover debt is still settled.`)

  rule('SCORING   the leaderboard')
  console.log(`  optimum_y      = abatement spend + coverRate × (planned − endowment)`)
  console.log(`     endowment   = free allocation + min(0, carry-in)`)
  console.log(`                   ↑ only what was RECEIVED free. An auction award and a banked`)
  console.log(`                     surplus were both bought, so the benchmark does not get them;`)
  console.log(`                     a make-good debt is real and still carries.`)
  console.log(`     coverRate   = min(market VWAP, auction clearing)  when short`)
  console.log(`                 = market VWAP                         when long`)
  console.log(``)
  console.log(`  decisionCost_y = abatement spend + purchases − sale income`)
  console.log(`                   + max(0, planned − held) × ${m.penaltyRate}`)
  console.log(`                   ↑ the fine taken against what you PLANNED for, not what the`)
  console.log(`                     dice produced, so the emission draw cancels on both sides`)
  console.log(``)
  console.log(`  investmentGap  = max(0, value of the payback rule's install − value of yours)`)
  console.log(`                   value(step) = ${C.abatement.investmentHorizon} × price × unabated × step − cost`)
  console.log(`                   judged at the price that was on screen when you decided`)
  console.log(``)
  console.log(`  gap            = [ Σ(decisionCost − optimum) + ${s.investmentWeight} × Σ investmentGap ] / baseline`)
  console.log(`  points         = 100 × exp(−gap / ${s.pointsScale})`)
  console.log(``)
  console.log(`  100 = you matched the benchmark · above 100 = you beat it · lower = you paid more`)
  console.log(`  Dividing by baseline tonnes is what makes the table size-neutral. Pure-trader`)
  console.log(`  bots get no points: no baseline, and nothing to abate.`)

  rule('KNOWN LIMITS   measured, not guessed')
  console.log(`  · Sector spread. On a mixed class the sector means still span ~15-19 points, and`)
  console.log(`    the top decile runs roughly 49/40/5/6 against an even 25/25/25/25. It follows`)
  console.log(`    the MAC curves and is largely inherent: a dear-to-abate sector moves more money,`)
  console.log(`    so the same proportional error is a bigger number. Flattening the curves removes`)
  console.log(`    it (spread 1.3) but also removes the lesson.`)
  console.log(`  · Luck. Companies running byte-identical strategy code still spread across the`)
  console.log(`    table; the cover error correlates about −0.6 with points. Charging the fine`)
  console.log(`    against 'planned' removed part of it, not all — the rest reaches the score`)
  console.log(`    through the carry, which is priced at next year's market.`)
}

console.log('')

import { DEFAULT_GAME_CONFIG, type DeepPartial, type GameConfig } from '../shared/config'
import { INDUSTRY_NAMES, SECTOR_AVERAGE_EMISSIONS, type Industry } from '../shared/constants'
import type { AbatementSpec } from '../shared/engine/abatementModels'
import type { BotType, CapMode } from '../shared/types'
import type { Population, RunSpec } from './runner'

export type { BotType, CapMode, Industry }

const CAP_MODES: CapMode[] = ['grandfathering', 'benchmarking', 'auctioning']

/**
 * An even class: a realistic classroom mix across behaviours and sectors.
 *
 * 25 students and 22 bots — the population the price calibration runs on, so the catalog
 * and the calibration sweeps describe the same market. They used to differ (24 + 10 here,
 * 25 + 22 there), which meant a scenario result and a sweep result could not be compared
 * even when they varied the same parameter.
 */
const BALANCED: Population = {
  humans: 25,
  behaviourMix: { rational: 0.4, passive: 0.25, hedger: 0.2, opportunist: 0.15 },
  sectorMix: {
    'Power & Utilities': 0.25,
    'Heavy Materials': 0.25,
    'Manufacturing & Chemicals': 0.25,
    Transport: 0.25,
  },
  bots: { compliance: 9, marketMaker: 4, noise: 6, speculator: 3 },
}

const pop = (over: Partial<Population>): Population => ({ ...BALANCED, ...over })

export interface ScenarioDef {
  name: string
  description: string
  /** Builds one run per parameter combination; the CLI multiplies these by seeds. */
  build: () => Omit<RunSpec, 'seed' | 'scenario'>[]
  /** Extra columns recorded on the run, so the SQL views can group by them. */
  params?: (spec: Omit<RunSpec, 'seed' | 'scenario'>) => Record<string, unknown>
}

/**
 * Ten years, not five.
 *
 * Abatement capacity is permanent and arrives a year late, so the interesting behaviour —
 * the class decarbonising out of its own scarcity, and the LRF having to keep up — does not
 * appear until well after year five. A five-year run measures the transient.
 */
const base = (over: Partial<Omit<RunSpec, 'seed' | 'scenario'>> = {}) => ({
  capMode: 'benchmarking' as CapMode,
  years: 10,
  ticksPerYear: 12,
  population: BALANCED,
  ...over,
})

/** The shipped values every grid below is centred on, read from the config rather than
 *  copied, so a change in `defaults.ts` moves the grids with it instead of silently
 *  leaving them describing an older game. */
const SHIPPED = {
  penalty: DEFAULT_GAME_CONFIG.market.penaltyRate,
  lrf: DEFAULT_GAME_CONFIG.allocation.capReductionFactor,
  freeCreditRatio: DEFAULT_GAME_CONFIG.allocation.freeCreditRatio,
  auctionCapRatio: DEFAULT_GAME_CONFIG.allocation.auctionCapRatio,
  lifetimeCap: DEFAULT_GAME_CONFIG.abatement.lifetimeCap,
  retrofitFee: DEFAULT_GAME_CONFIG.abatement.fixedCostPerTonneBaseline,
}

export const SCENARIOS: ScenarioDef[] = [
  {
    name: 'baseline',
    description: 'The three cap regimes on an identical, balanced class, at shipped settings.',
    build: () => CAP_MODES.map((capMode) => base({ capMode })),
    params: (s) => ({ capMode: s.capMode }),
  },
  {
    name: 'depth-sweep',
    description:
      'Market-maker count × class size. Answers where market shallowness starts to bite: ' +
      'watch spread, price impact and one-sided ticks as liquidity thins.',
    build: () => {
      const specs: Omit<RunSpec, 'seed' | 'scenario'>[] = []
      for (const marketMakers of [0, 1, 2, 4]) {
        for (const humans of [6, 12, 25, 48]) {
          specs.push(
            base({
              population: pop({
                humans,
                bots: { compliance: 9, marketMaker: marketMakers, noise: 6, speculator: 3 },
              }),
            }),
          )
        }
      }
      return specs
    },
    params: (s) => ({
      humans: s.population.humans,
      marketMakers: s.population.bots.marketMaker ?? 0,
    }),
  },
  {
    name: 'abatement-models',
    description:
      'The same class under four MAC curves, each calibrated to the same first-tonne cost ' +
      'as the shipped linear curve so only the SHAPE differs.',
    build: () => {
      // Anchored on the shipped linear curves rather than on numbers chosen for an older
      // penalty. Every form starts at the same MAC(0) = a and reaches the same MAC(1) = a+b,
      // so a difference in outcome is a difference in curvature and nothing else.
      const models: DeepPartial<GameConfig>[] = [
        {},
        { abatement: { sectors: shapedSectors('power', { n: 2.5 }) } },
        { abatement: { sectors: shapedSectors('exponential', { k: 2.5 }) } },
        { abatement: { sectors: shapedSectors('tiered', {}) } },
      ]
      return models.map((config) => base({ config }))
    },
    params: (s) => ({
      model:
        (s.config?.abatement?.sectors?.Transport as { model?: string } | undefined)?.model ??
        'linear',
    }),
  },
  {
    name: 'stringency-sweep',
    description: 'Benchmark tightness, from generous to punishing.',
    build: () =>
      [1, 0.8, 0.6, 0.45, 0.3].map((stringency) =>
        base({
          capMode: 'benchmarking',
          config: { allocation: { benchmark: benchmarkTable(stringency) } },
        }),
      ),
    params: (s) => ({
      benchmarkTransport: (s.config?.allocation?.benchmark as Record<string, number>)?.Transport,
    }),
  },
  {
    name: 'penalty-sweep',
    description:
      'Where the penalty ceiling stops binding on the market price. Spans the shipped €100 ' +
      '(the real EU ETS figure) and its inflation-indexed value.',
    build: () =>
      // The old grid was [10, 20, 35, 60] — every point BELOW the shipped penalty, chosen
      // when the fine was 60. A sweep that never reaches the shipped value cannot say
      // whether the shipped value binds.
      [60, 80, SHIPPED.penalty, 130, 160, 200].map((penaltyRate) =>
        base({ config: { market: { penaltyRate } } }),
      ),
    params: (s) => ({ penaltyRate: s.config?.market?.penaltyRate }),
  },
  {
    name: 'lrf-sweep',
    description:
      'Supply tightening rate, across the EU-realistic window (−2%/yr Phase 4 … −4.3%/yr ' +
      'from 2024) and beyond it. Run on all three regimes, grandfathering with the LRF ON.',
    build: () =>
      CAP_MODES.flatMap((capMode) =>
        [0.98, 0.97, 0.957, SHIPPED.lrf, 0.94, 0.92, 0.9].map((capReductionFactor) =>
          base({
            capMode,
            config: {
              allocation: {
                capReductionFactor,
                // Otherwise the grandfathering arm is a flat line: the shipped default
                // exempts it, so every point in the grid would issue the same supply.
                applyLRFToGrandfathering: true,
              },
            },
          }),
        ),
      ),
    params: (s) => ({
      capMode: s.capMode,
      lrf: s.config?.allocation?.capReductionFactor,
    }),
  },
  {
    name: 'lifetime-cap-sweep',
    description:
      'How much of its own emissions a company may ever cut. Sets the dearest cut anyone ' +
      'is allowed, MAC(cap) = a + cap·b, and so the fundamental ceiling on willingness to pay.',
    build: () =>
      CAP_MODES.flatMap((capMode) =>
        [0.2, 0.3, 0.4, SHIPPED.lifetimeCap, 0.6, 0.7].map((lifetimeCap) =>
          base({ capMode, config: { abatement: { lifetimeCap } } }),
        ),
      ),
    params: (s) => ({ capMode: s.capMode, lifetimeCap: s.config?.abatement?.lifetimeCap }),
  },
  {
    name: 'retrofit-fee-sweep',
    description:
      'The per-step retrofit fee, the only thing discouraging a company from nibbling its ' +
      'way to the lifetime cap. 0 is the control arm: with no fee, stepping is free.',
    build: () =>
      [0, 0.5, 1, SHIPPED.retrofitFee, 3, 5].map((fixedCostPerTonneBaseline) =>
        base({ config: { abatement: { fixedCostPerTonneBaseline } } }),
      ),
    params: (s) => ({ retrofitFee: s.config?.abatement?.fixedCostPerTonneBaseline }),
  },
  {
    name: 'reserve-sweep',
    description:
      'The cost containment reserve: off, shipped ladder, and the ladder moved up and down ' +
      '€10. It is meant to relieve a squeeze, not to set the price — watch reserve_share.',
    build: () => {
      const shipped = DEFAULT_GAME_CONFIG.allocation.reserve.steps
      const shifted = (by: number) =>
        shipped.map((s) => ({ ...s, triggerPrice: s.triggerPrice + by }))
      return CAP_MODES.flatMap((capMode) => [
        base({ capMode, config: { allocation: { reserve: { enabled: false } } } }),
        base({ capMode, config: { allocation: { reserve: { enabled: true } } } }),
        base({
          capMode,
          config: { allocation: { reserve: { enabled: true, steps: shifted(-10) } } },
        }),
        base({
          capMode,
          config: { allocation: { reserve: { enabled: true, steps: shifted(10) } } },
        }),
        // The only variant that arms under auctioning at a supply ratio of 1, where the
        // shortfall — and therefore the shipped pot — is exactly zero.
        base({
          capMode,
          config: { allocation: { reserve: { enabled: true, basis: 'need' } } },
        }),
      ])
    },
    params: (s) => {
      const r = s.config?.allocation?.reserve
      return {
        capMode: s.capMode,
        reserveEnabled: r?.enabled ?? true,
        reserveBasis: r?.basis ?? 'shortfall',
        firstTrigger: (r?.steps as { triggerPrice: number }[] | undefined)?.[0]?.triggerPrice,
      }
    },
  },
  {
    name: 'bot-fixes',
    description:
      'The five behavioural flags, at their shipped values and all on. `ceilingIncludesCarry` ' +
      'is the one that lets an uncoverable shortage price above the fine.',
    build: () =>
      CAP_MODES.flatMap((capMode) => [
        base({ capMode }),
        base({
          capMode,
          config: {
            bots: {
              fixes: {
                noiseAbatement: true,
                complianceReservation: true,
                marketMakerIncrementalBid: true,
                marketMakerShareByCount: true,
                ceilingIncludesCarry: true,
              },
            },
          },
        }),
      ]),
    params: (s) => ({
      capMode: s.capMode,
      fixes: s.config?.bots?.fixes ? 'all-on' : 'shipped',
    }),
  },
  {
    name: 'behaviour-mix',
    description:
      'From an all-passive class to an all-rational one — how much irrationality the ' +
      'market absorbs before the price stops making sense.',
    build: () => {
      const mixes: [string, Population['behaviourMix']][] = [
        ['all-passive', { passive: 1 }],
        ['mostly-passive', { passive: 0.7, rational: 0.3 }],
        ['balanced', BALANCED.behaviourMix],
        ['mostly-rational', { rational: 0.8, opportunist: 0.2 }],
        ['all-rational', { rational: 1 }],
      ]
      return mixes.map(([, behaviourMix]) => base({ population: pop({ behaviourMix }) }))
    },
    params: (s) => ({ behaviourMix: s.population.behaviourMix }),
  },
  {
    name: 'sector-mix',
    description: 'A class concentrated in one sector — can a cheap-abatement sector corner it?',
    build: () =>
      INDUSTRY_NAMES.map((industry) => base({ population: pop({ sectorMix: { [industry]: 1 } }) })),
    params: (s) => ({ sectorMix: s.population.sectorMix }),
  },
]

/**
 * Benchmark table at an arbitrary stringency (fraction of the sector average).
 *
 * Derived from `SECTOR_AVERAGE_EMISSIONS`, never from a copied table. The averages used to
 * be written out here by hand, so a change to the `INDUSTRIES` ranges would have moved the
 * game's benchmark while leaving this sweep quietly describing the old one.
 *
 * NOTE `allocation.benchmarkStringency` is dead config — `benchmarkFor` reads
 * `allocation.benchmark`, so the TABLE is what a scenario has to move.
 */
function benchmarkTable(stringency: number): Record<Industry, number> {
  return Object.fromEntries(
    INDUSTRY_NAMES.map((i) => [i, Math.round(SECTOR_AVERAGE_EMISSIONS[i] * stringency * 10) / 10]),
  ) as Record<Industry, number>
}

/**
 * A non-linear MAC for every sector, matched to that sector's shipped linear curve at both
 * ends: MAC(0) = a and MAC(1) = a + b. Only the path between them differs.
 *
 * Without this anchoring the comparison is confounded — the old fixture gave every sector
 * the same hardcoded curve, so a "shape" result was really a result about Heavy Materials
 * being handed Power's costs.
 */
function shapedSectors(
  model: 'power' | 'exponential' | 'tiered',
  shape: { n?: number; k?: number },
): Record<Industry, AbatementSpec> {
  return Object.fromEntries(
    INDUSTRY_NAMES.map((i): [Industry, AbatementSpec] => {
      const { a, b } = DEFAULT_GAME_CONFIG.abatement.sectors[i].params as { a: number; b: number }
      if (model === 'power') return [i, { model, params: { a, b, n: shape.n ?? 2.5 } }]
      // MAC(f) = a·e^{kf} reaches a + b at f = 1 when a·e^k = a + b.
      if (model === 'exponential') return [i, { model, params: { a, k: Math.log((a + b) / a) } }]
      return [
        i,
        {
          model,
          params: {
            tiers: [
              { upTo: 0.25, rate: a },
              { upTo: 0.6, rate: a + b * 0.5 },
              { upTo: 1, rate: a + b },
            ],
          },
        },
      ]
    }),
  ) as Record<Industry, AbatementSpec>
}

export function getScenario(name: string): ScenarioDef {
  const found = SCENARIOS.find((s) => s.name === name)
  if (!found) {
    throw new Error(`Unknown scenario "${name}". Available: ${SCENARIOS.map((s) => s.name).join(', ')}`)
  }
  return found
}

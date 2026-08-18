import type { DeepPartial, GameConfig } from '../shared/config'
import type { Industry } from '../shared/constants'
import type { BotType, CapMode } from '../shared/types'
import type { Population, RunSpec } from './runner'

export type { BotType, CapMode, Industry }

const CAP_MODES: CapMode[] = ['grandfathering', 'benchmarking', 'auctioning']

/** An even class: a realistic classroom mix across behaviours and sectors. */
const BALANCED: Population = {
  humans: 24,
  behaviourMix: { rational: 0.4, passive: 0.25, hedger: 0.2, opportunist: 0.15 },
  sectorMix: {
    'Power & Utilities': 0.25,
    'Heavy Materials': 0.25,
    'Manufacturing & Chemicals': 0.25,
    Transport: 0.25,
  },
  bots: { compliance: 4, marketMaker: 2, noise: 3, speculator: 1 },
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

const base = (over: Partial<Omit<RunSpec, 'seed' | 'scenario'>> = {}) => ({
  capMode: 'benchmarking' as CapMode,
  years: 5,
  ticksPerYear: 12,
  population: BALANCED,
  ...over,
})

export const SCENARIOS: ScenarioDef[] = [
  {
    name: 'baseline',
    description: 'The three cap regimes on an identical, balanced class.',
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
        for (const humans of [6, 12, 24, 48]) {
          specs.push(
            base({
              population: pop({
                humans,
                bots: { compliance: 2, marketMaker: marketMakers, noise: 2, speculator: 1 },
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
      'The same class under four MAC curves. Exponential and tiered make deep cuts far ' +
      'dearer, which should push demand — and the price — up.',
    build: () => {
      const models: DeepPartial<GameConfig>[] = [
        {},
        { abatement: { sectors: allSectors({ model: 'power', params: { a: 3, b: 25, n: 2.5 } }) } },
        { abatement: { sectors: allSectors({ model: 'exponential', params: { a: 3, k: 2.5 } }) } },
        {
          abatement: {
            sectors: allSectors({
              model: 'tiered',
              params: {
                tiers: [
                  { upTo: 0.25, rate: 4 },
                  { upTo: 0.6, rate: 16 },
                  { upTo: 1, rate: 65 },
                ],
              },
            }),
          },
        },
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
          config: { allocation: { benchmark: scaledBenchmark(stringency) } },
        }),
      ),
    params: (s) => ({
      benchmarkTransport: (s.config?.allocation?.benchmark as Record<string, number>)?.Transport,
    }),
  },
  {
    name: 'penalty-sweep',
    description: 'Where the penalty ceiling stops binding on the market price.',
    build: () =>
      [10, 20, 35, 60].map((penaltyRate) => base({ config: { market: { penaltyRate } } })),
    params: (s) => ({ penaltyRate: s.config?.market?.penaltyRate }),
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
      (
        [
          'Power & Utilities',
          'Heavy Materials',
          'Manufacturing & Chemicals',
          Transport(),
        ] as Industry[]
      ).map((industry) => base({ population: pop({ sectorMix: { [industry]: 1 } }) })),
    params: (s) => ({ sectorMix: s.population.sectorMix }),
  },
]

function Transport(): Industry {
  return 'Transport'
}

function allSectors<T>(spec: T): Record<Industry, T> {
  return {
    'Power & Utilities': spec,
    'Heavy Materials': spec,
    'Manufacturing & Chemicals': spec,
    Transport: spec,
  }
}

/** Benchmark table at an arbitrary stringency (fraction of the sector average). */
function scaledBenchmark(stringency: number): Record<Industry, number> {
  const averages: Record<Industry, number> = {
    'Power & Utilities': 1000,
    'Heavy Materials': 800,
    'Manufacturing & Chemicals': 525,
    Transport: 300,
  }
  return Object.fromEntries(
    Object.entries(averages).map(([k, avg]) => [k, Math.round(avg * stringency * 10) / 10]),
  ) as Record<Industry, number>
}

export function getScenario(name: string): ScenarioDef {
  const found = SCENARIOS.find((s) => s.name === name)
  if (!found) {
    throw new Error(`Unknown scenario "${name}". Available: ${SCENARIOS.map((s) => s.name).join(', ')}`)
  }
  return found
}

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { allocateMix, BEHAVIOURS, type Behaviour } from '../agents/behaviours'
import { SimDb } from '../db'
import { runScenario, type RunSpec } from '../runner'
import { SCENARIOS, getScenario } from '../scenarios'

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  scenario: 'test',
  capMode: 'benchmarking',
  seed: 42,
  years: 2,
  ticksPerYear: 6,
  population: {
    humans: 8,
    behaviourMix: { rational: 0.5, passive: 0.25, hedger: 0.125, opportunist: 0.125 },
    sectorMix: { 'Power & Utilities': 0.5, Transport: 0.5 },
    bots: { compliance: 2, marketMaker: 1, noise: 1 },
  },
  ...over,
})

describe('allocateMix', () => {
  it('apportions exactly, with no drift from rounding', () => {
    const out = allocateMix<Behaviour>({ rational: 0.7, passive: 0.3 }, 10)
    expect(out).toHaveLength(10)
    expect(out.filter((b) => b === 'rational')).toHaveLength(7)
    expect(out.filter((b) => b === 'passive')).toHaveLength(3)
  })

  it('handles weights that do not divide evenly, and counts smaller than the mix', () => {
    expect(allocateMix<Behaviour>({ rational: 1, passive: 1, hedger: 1 }, 7)).toHaveLength(7)
    expect(allocateMix<Behaviour>({ rational: 1, passive: 1, hedger: 1 }, 2)).toHaveLength(2)
  })

  it('rejects an empty mix rather than silently producing no players', () => {
    expect(() => allocateMix<Behaviour>({}, 5)).toThrow(/positive weight/)
    expect(() => allocateMix<Behaviour>({ rational: 0 }, 5)).toThrow(/positive weight/)
  })
})

describe('runScenario', () => {
  it('is deterministic for a given seed', () => {
    const a = runScenario(spec())
    const b = runScenario(spec())
    expect(b.years.map((y) => y.metrics)).toEqual(a.years.map((y) => y.metrics))
  })

  it('diverges with a different seed (the RNG is actually wired through)', () => {
    const a = runScenario(spec())
    const b = runScenario(spec({ seed: 43 }))
    expect(b.years[0].metrics).not.toEqual(a.years[0].metrics)
  })

  it('produces one settled year per requested year, with finite metrics', () => {
    const result = runScenario(spec({ years: 3 }))
    expect(result.years.map((y) => y.year)).toEqual([11, 12, 13])
    for (const y of result.years) {
      for (const [key, value] of Object.entries(y.metrics)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${key} was ${value}`).toBe(true)
        }
      }
      expect(y.players).toHaveLength(8 + 4) // students + bots
    }
  })

  it('records every student with a behaviour and every bot without one', () => {
    const rows = runScenario(spec()).years[0].players
    for (const r of rows) {
      expect(r.isBot ? r.behaviour === null : BEHAVIOURS.includes(r.behaviour as Behaviour)).toBe(true)
    }
  })

  it('runs all three cap modes, and the auction path submits bids', () => {
    for (const capMode of ['grandfathering', 'benchmarking', 'auctioning'] as const) {
      const result = runScenario(spec({ capMode }))
      expect(result.years).toHaveLength(2)
      expect(result.years[0].metrics.totalRealized).toBeGreaterThan(0)
    }
    // Only auctioning creates a priced primary supply.
    expect(runScenario(spec({ capMode: 'auctioning' })).years[0].metrics.regulatorPool)
      .toBeGreaterThan(0)
    expect(runScenario(spec({ capMode: 'benchmarking' })).years[0].metrics.regulatorPool).toBe(0)
  })

  it('honours a config override — a non-linear MAC curve runs end to end', () => {
    const result = runScenario(
      spec({
        config: {
          market: { penaltyRate: 45 },
          abatement: {
            sectors: {
              Transport: {
                model: 'tiered',
                params: {
                  tiers: [
                    { upTo: 0.4, rate: 3 },
                    { upTo: 1, rate: 70 },
                  ],
                },
              },
            },
          },
        },
      }),
    )
    expect(result.years).toHaveLength(2)
    expect(Number.isFinite(result.years[0].metrics.classCost)).toBe(true)
  })

  it('a tighter benchmark raises the discovered price', () => {
    const loose = runScenario(
      spec({ config: { allocation: { benchmark: { 'Power & Utilities': 1000, Transport: 300 } } } }),
    )
    const tight = runScenario(
      spec({ config: { allocation: { benchmark: { 'Power & Utilities': 300, Transport: 90 } } } }),
    )
    const vwap = (r: ReturnType<typeof runScenario>) => r.years[0].metrics.vwap ?? 0
    expect(vwap(tight)).toBeGreaterThan(vwap(loose))
  })
})

describe('scenario catalog', () => {
  it('every scenario builds runnable specs with unique names', () => {
    const names = SCENARIOS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const scenario of SCENARIOS) {
      const specs = scenario.build()
      expect(specs.length).toBeGreaterThan(0)
      for (const s of specs) {
        expect(s.population.humans).toBeGreaterThan(0)
        expect(s.years).toBeGreaterThan(0)
      }
    }
  })

  it('getScenario names the alternatives when asked for a missing one', () => {
    expect(() => getScenario('nope')).toThrow(/Available:/)
  })

  it('a scenario variant actually runs', () => {
    const scenario = getScenario('abatement-models')
    const [first] = scenario.build()
    const result = runScenario({ ...first, scenario: scenario.name, seed: 7, years: 1 })
    expect(result.years).toHaveLength(1)
  })
})

describe('SimDb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-db-'))
  const db = new SimDb(join(dir, 'test.db'))
  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a run through the single sqlite file', () => {
    const result = runScenario(spec())
    db.insertRun({
      runId: 'r1',
      scenario: 'test',
      capMode: 'benchmarking',
      seed: 42,
      years: 2,
      params: { marketMakers: 1, humans: 8 },
      population: {},
    })
    for (const y of result.years) {
      db.insertYear('r1', y.year, y.metrics)
      db.insertPlayers('r1', y.year, y.players)
    }
    db.insertTrades('r1', 11, result.trades.filter((t) => t.year === 11))

    expect(db.query(`SELECT COUNT(*) AS n FROM runs`)).toEqual([{ n: 1 }])
    expect(db.query(`SELECT COUNT(*) AS n FROM years`)).toEqual([{ n: 2 }])
    expect(db.query(`SELECT COUNT(*) AS n FROM players`)).toEqual([{ n: 24 }])
    // The views the CLI prints must survive a schema change.
    expect(() => db.query(`SELECT * FROM v_price_by_scenario`)).not.toThrow()
    expect(() => db.query(`SELECT * FROM v_depth_by_scenario`)).not.toThrow()
    expect(() => db.query(`SELECT * FROM v_efficiency_by_behaviour`)).not.toThrow()
  })

  it('re-recording the same run replaces rather than duplicates', () => {
    const before = db.query(`SELECT COUNT(*) AS n FROM years`)
    const result = runScenario(spec())
    for (const y of result.years) db.insertYear('r1', y.year, y.metrics)
    expect(db.query(`SELECT COUNT(*) AS n FROM years`)).toEqual(before)
  })
})

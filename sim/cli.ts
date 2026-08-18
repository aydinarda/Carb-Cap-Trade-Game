import { DEFAULT_DB_PATH, SimDb } from './db'
import { runScenario, type RunSpec } from './runner'
import { getScenario, SCENARIOS } from './scenarios'

/**
 * Scenario runner.
 *
 *   pnpm sim                                  # every scenario, 5 seeds each
 *   pnpm sim -- --scenario depth-sweep --seeds 20
 *   pnpm sim -- --scenario abatement-models --years 8 --trades
 *   pnpm sim -- --list
 *   pnpm sim -- --reset                       # wipe previous runs first
 *
 * Everything lands in one SQLite file (sim/out/sim.db) and accumulates across runs.
 */
function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.list) {
  console.log('Scenarios:\n')
  for (const s of SCENARIOS) console.log(`  ${s.name.padEnd(20)} ${s.description}`)
  process.exit(0)
}

const seeds = Number(args.seeds ?? 5)
const dbPath = String(args.db ?? DEFAULT_DB_PATH)
const withTrades = !!args.trades
const chosen = args.scenario ? [getScenario(String(args.scenario))] : SCENARIOS

const db = new SimDb(dbPath)
if (args.reset) {
  db.reset()
  console.log('cleared previous runs')
}

const started = Date.now()
let runCount = 0
let yearCount = 0

for (const scenario of chosen) {
  const specs = scenario.build()
  console.log(`\n── ${scenario.name} — ${specs.length} config(s) × ${seeds} seed(s)`)
  for (let variant = 0; variant < specs.length; variant++) {
    const partial = specs[variant]
    for (let s = 0; s < seeds; s++) {
      const seed = 1000 + s
      const spec: RunSpec = {
        ...partial,
        ...(args.years ? { years: Number(args.years) } : {}),
        scenario: scenario.name,
        seed,
      }
      const runId = `${scenario.name}:${variant}:${seed}`
      const result = runScenario(spec)

      db.insertRun({
        runId,
        scenario: scenario.name,
        capMode: spec.capMode,
        seed,
        years: spec.years,
        params: scenario.params?.(partial) ?? {},
        population: spec.population as unknown as Record<string, unknown>,
      })
      for (const y of result.years) {
        db.insertYear(runId, y.year, y.metrics)
        db.insertPlayers(runId, y.year, y.players)
        yearCount++
      }
      if (withTrades) {
        for (const y of result.years) {
          db.insertTrades(
            runId,
            y.year,
            result.trades.filter((t) => t.year === y.year),
          )
        }
      }
      runCount++
    }
    const last = specs[variant]
    process.stdout.write(
      `   variant ${variant + 1}/${specs.length} (${last.capMode}, ${last.population.humans} students) ✓\n`,
    )
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\n${runCount} runs · ${yearCount} years · ${elapsed}s → ${dbPath}`)

// A short readout so a sweep is useful without opening a SQL client.
const summary = db.query(`SELECT * FROM v_price_by_scenario`) as Record<string, unknown>[]
if (summary.length) {
  console.log('\nPrice by scenario:')
  console.table(summary)
}
const depth = db.query(
  `SELECT * FROM v_depth_by_scenario WHERE market_makers IS NOT NULL ORDER BY humans, market_makers`,
) as Record<string, unknown>[]
if (depth.length) {
  console.log('\nMarket depth (the shallowness question):')
  console.table(depth)
}

db.close()

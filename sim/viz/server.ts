import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_DB_PATH, SimDb } from '../db'

/**
 * Local dashboard over sim/out/sim.db.
 *
 * Deliberately dependency-free and build-free: a plain Node server plus one
 * self-contained HTML page, so `pnpm sim:viz` works straight after a run without
 * touching the client's Vite build. The aggregation lives here in SQL; the page only
 * draws.
 */
const here = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const argOf = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const port = Number(argOf('port', '3002'))
const dbPath = argOf('db', DEFAULT_DB_PATH)

const db = new SimDb(dbPath)
const q = <T>(sql: string) => db.query(sql) as T[]

/** Every panel the page can draw. Panels with no rows are hidden client-side. */
function buildPayload() {
  const scenarios = q<{ scenario: string; runs: number }>(
    `SELECT scenario, COUNT(*) AS runs FROM runs GROUP BY scenario ORDER BY scenario`,
  )

  return {
    meta: {
      dbPath,
      scenarios,
      totals: q<{ runs: number; years: number }>(
        `SELECT (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM years) AS years`,
      )[0],
    },

    // Price discovery over the game, one line per cap regime.
    pricePath: q(
      `SELECT r.cap_mode AS capMode, y.year AS year,
              ROUND(AVG(y.vwap), 2) AS vwap,
              ROUND(AVG(y.efficient_price), 2) AS efficient,
              COUNT(*) AS n
       FROM years y JOIN runs r USING (run_id)
       WHERE r.scenario = 'baseline' AND y.vwap IS NOT NULL
       GROUP BY r.cap_mode, y.year ORDER BY r.cap_mode, y.year`,
    ),

    // The shallowness question: liquidity vs class size, at each market-maker count.
    depth: q(
      `SELECT CAST(json_extract(r.params, '$.humans') AS INTEGER) AS humans,
              CAST(json_extract(r.params, '$.marketMakers') AS INTEGER) AS marketMakers,
              ROUND(AVG(y.one_sided_frac), 4) AS oneSided,
              ROUND(AVG(y.spread_mean), 3) AS spread,
              ROUND(AVG(y.price_impact), 4) AS impact,
              ROUND(AVG(y.depth_mean), 1) AS depth,
              ROUND(AVG(y.fill_rate), 3) AS fillRate,
              COUNT(*) AS n
       FROM years y JOIN runs r USING (run_id)
       WHERE r.scenario = 'depth-sweep'
       GROUP BY humans, marketMakers ORDER BY marketMakers, humans`,
    ),

    // How the shape of the abatement curve moves price and behaviour.
    models: q(
      `SELECT json_extract(r.params, '$.model') AS model,
              ROUND(AVG(y.vwap), 2) AS vwap,
              ROUND(AVG(y.total_abated), 0) AS abated,
              ROUND(AVG(y.total_penalty), 0) AS penalty,
              ROUND(AVG(y.class_cost), 0) AS cost,
              COUNT(*) AS n
       FROM years y JOIN runs r USING (run_id)
       WHERE r.scenario = 'abatement-models'
       GROUP BY model ORDER BY vwap`,
    ),

    stringency: q(
      `SELECT CAST(json_extract(r.params, '$.benchmarkTransport') AS REAL) AS benchmark,
              ROUND(AVG(y.vwap), 2) AS vwap,
              ROUND(AVG(y.ceiling_frac), 4) AS ceiling,
              ROUND(AVG(y.total_penalty), 0) AS penalty,
              COUNT(*) AS n
       FROM years y JOIN runs r USING (run_id)
       WHERE r.scenario = 'stringency-sweep'
       GROUP BY benchmark ORDER BY benchmark DESC`,
    ),

    penalty: q(
      `SELECT CAST(json_extract(r.params, '$.penaltyRate') AS REAL) AS penaltyRate,
              ROUND(AVG(y.vwap), 2) AS vwap,
              ROUND(AVG(y.ceiling_frac), 4) AS ceiling,
              COUNT(*) AS n
       FROM years y JOIN runs r USING (run_id)
       WHERE r.scenario = 'penalty-sweep'
       GROUP BY penaltyRate ORDER BY penaltyRate`,
    ),

    // How each simulated student archetype does against its own optimum.
    behaviour: q(
      `SELECT p.behaviour AS behaviour,
              ROUND(AVG(p.year_cost - p.optimal_cost), 1) AS excess,
              ROUND(AVG(p.year_cost), 1) AS cost,
              ROUND(AVG(p.abatement), 4) AS abatement,
              COUNT(*) AS n
       FROM players p
       WHERE p.is_bot = 0 AND p.behaviour IS NOT NULL
       GROUP BY p.behaviour ORDER BY excess`,
    ),
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(buildPayload()))
    return
  }

  // Read-only SQL escape hatch, so the dashboard never boxes you in.
  if (url.pathname === '/api/query') {
    const sql = url.searchParams.get('sql') ?? ''
    if (!/^\s*(select|with)\b/i.test(sql)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Only SELECT / WITH queries are allowed.' }))
      return
    }
    try {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ rows: db.query(sql) }))
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: (e as Error).message }))
    }
    return
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(join(here, 'page.html'), 'utf8'))
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

server.listen(port, () => {
  const { runs, years } = buildPayload().meta.totals
  console.log(`sim dashboard → http://localhost:${port}`)
  console.log(`  ${dbPath} · ${runs} runs · ${years} years`)
  if (runs === 0) console.log('  (no data yet — run `pnpm sim` first)')
})

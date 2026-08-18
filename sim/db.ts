import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { YearMetrics } from './metrics'

/**
 * Single append-only SQLite file for every simulation run.
 *
 * Uses Node's built-in `node:sqlite`, so the harness adds no dependency. Runs accumulate
 * across invocations — a sweep can be resumed, and old runs stay comparable — so always
 * filter by `run_id` or `scenario` when querying.
 */
export const DEFAULT_DB_PATH = 'sim/out/sim.db'

export interface RunMeta {
  runId: string
  scenario: string
  capMode: string
  seed: number
  years: number
  params: Record<string, unknown>
  population: Record<string, unknown>
}

export interface PlayerRow {
  playerId: string
  behaviour: string | null
  industry: string
  isBot: boolean
  botType: string | null
  freeAllocation: number
  regulatorGranted: number
  held: number
  realized: number
  abatement: number
  tradedNet: number
  yearCost: number
  optimalCost: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  scenario    TEXT NOT NULL,
  cap_mode    TEXT NOT NULL,
  seed        INTEGER NOT NULL,
  years       INTEGER NOT NULL,
  params      TEXT NOT NULL,
  population  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS years (
  run_id             TEXT NOT NULL,
  year               INTEGER NOT NULL,
  vwap               REAL, last_price REAL, price_min REAL, price_max REAL,
  price_stdev        REAL, ceiling_frac REAL,
  efficient_price    REAL, price_vs_efficient REAL,
  spread_mean        REAL, depth_mean REAL, one_sided_frac REAL,
  order_to_trade     REAL, fill_rate REAL, price_impact REAL,
  bot_volume_share   REAL, unfilled_demand REAL,
  volume             REAL, trade_count INTEGER,
  free_allocation    REAL, regulator_pool REAL,
  total_expected     REAL, total_realized REAL, total_abated REAL,
  total_penalty      REAL, class_cost REAL, optimal_cost REAL,
  PRIMARY KEY (run_id, year),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS players (
  run_id     TEXT NOT NULL,
  year       INTEGER NOT NULL,
  player_id  TEXT NOT NULL,
  behaviour  TEXT,
  industry   TEXT NOT NULL,
  is_bot     INTEGER NOT NULL,
  bot_type   TEXT,
  free_allocation REAL, regulator_granted REAL, held REAL, realized REAL,
  abatement REAL, traded_net REAL, year_cost REAL, optimal_cost REAL,
  PRIMARY KEY (run_id, year, player_id)
);

CREATE TABLE IF NOT EXISTS trades (
  run_id TEXT NOT NULL, year INTEGER NOT NULL, seq INTEGER NOT NULL,
  price REAL NOT NULL, qty REAL NOT NULL,
  buyer_kind TEXT, seller_kind TEXT
);

CREATE INDEX IF NOT EXISTS idx_years_scenario ON years(run_id);
CREATE INDEX IF NOT EXISTS idx_players_run ON players(run_id, year);

-- Convenience views for the questions this harness exists to answer.
CREATE VIEW IF NOT EXISTS v_price_by_scenario AS
  SELECT r.scenario, r.cap_mode, COUNT(*) AS n,
         ROUND(AVG(y.vwap), 2) AS avg_vwap,
         ROUND(AVG(y.price_vs_efficient), 2) AS avg_gap_to_efficient,
         ROUND(AVG(y.ceiling_frac), 3) AS avg_ceiling_frac
  FROM years y JOIN runs r USING (run_id)
  WHERE y.vwap IS NOT NULL
  GROUP BY r.scenario, r.cap_mode;

CREATE VIEW IF NOT EXISTS v_depth_by_scenario AS
  SELECT r.scenario, r.cap_mode,
         json_extract(r.params, '$.marketMakers') AS market_makers,
         json_extract(r.params, '$.humans') AS humans,
         COUNT(*) AS n,
         ROUND(AVG(y.spread_mean), 2) AS avg_spread,
         ROUND(AVG(y.depth_mean), 1) AS avg_depth,
         ROUND(AVG(y.one_sided_frac), 3) AS avg_one_sided,
         ROUND(AVG(y.price_impact), 3) AS avg_impact,
         ROUND(AVG(y.fill_rate), 3) AS avg_fill_rate
  FROM years y JOIN runs r USING (run_id)
  GROUP BY r.scenario, r.cap_mode, market_makers, humans;

CREATE VIEW IF NOT EXISTS v_efficiency_by_behaviour AS
  SELECT r.scenario, p.behaviour, COUNT(*) AS n,
         ROUND(AVG(p.year_cost), 1) AS avg_cost,
         ROUND(AVG(p.year_cost - p.optimal_cost), 1) AS avg_excess_over_optimum,
         ROUND(AVG(p.abatement), 3) AS avg_abatement
  FROM players p JOIN runs r USING (run_id)
  WHERE p.is_bot = 0
  GROUP BY r.scenario, p.behaviour;
`

export class SimDb {
  private db: DatabaseSync

  constructor(path: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  /** Drops every recorded run, keeping the schema. */
  reset() {
    for (const t of ['trades', 'players', 'years', 'runs']) this.db.exec(`DELETE FROM ${t}`)
  }

  insertRun(meta: RunMeta) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs (run_id, ts, scenario, cap_mode, seed, years, params, population)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.runId,
        new Date().toISOString(),
        meta.scenario,
        meta.capMode,
        meta.seed,
        meta.years,
        JSON.stringify(meta.params),
        JSON.stringify(meta.population),
      )
  }

  insertYear(runId: string, year: number, m: YearMetrics) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO years VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId, year,
        m.vwap, m.lastPrice, m.priceMin, m.priceMax, m.priceStdev, m.ceilingFrac,
        m.efficientPrice, m.priceVsEfficient,
        m.spreadMean, m.depthMean, m.oneSidedFrac,
        m.orderToTrade, m.fillRate, m.priceImpact,
        m.botVolumeShare, m.unfilledDemand,
        m.volume, m.tradeCount,
        m.freeAllocation, m.regulatorPool,
        m.totalExpected, m.totalRealized, m.totalAbated,
        m.totalPenalty, m.classCost, m.optimalCost,
      )
  }

  insertPlayers(runId: string, year: number, rows: PlayerRow[]) {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO players VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) {
      stmt.run(
        runId, year, r.playerId, r.behaviour, r.industry, r.isBot ? 1 : 0, r.botType,
        r.freeAllocation, r.regulatorGranted, r.held, r.realized,
        r.abatement, r.tradedNet, r.yearCost, r.optimalCost,
      )
    }
  }

  insertTrades(
    runId: string,
    year: number,
    trades: { seq: number; price: number; qty: number; buyerKind: string; sellerKind: string }[],
  ) {
    const stmt = this.db.prepare(`INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const t of trades) {
      stmt.run(runId, year, t.seq, t.price, t.qty, t.buyerKind, t.sellerKind)
    }
  }

  query(sql: string): unknown[] {
    return this.db.prepare(sql).all()
  }

  close() {
    this.db.close()
  }
}

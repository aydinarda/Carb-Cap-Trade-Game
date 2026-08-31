import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FinalMetrics, YearMetrics } from './metrics'

/**
 * Single append-only SQLite file for every simulation run.
 *
 * Uses Node's built-in `node:sqlite`, so the harness adds no dependency. Runs accumulate
 * across invocations — a sweep can be resumed, and old runs stay comparable — so always
 * filter by `run_id` or `scenario` when querying.
 */
export const DEFAULT_DB_PATH = 'sim/out/sim.db'

/**
 * Bump this whenever a column is added, removed or renamed.
 *
 * `CREATE TABLE IF NOT EXISTS` does NOT add a column to a file that already exists, so a db
 * written before a metric was added silently keeps the old shape and every later insert
 * either fails or writes nothing — the trap the sweep scripts each carried a warning about
 * ("delete the stale db first"). The file is a regenerable analysis artifact, not a record
 * of anything, so the honest handling is to notice the mismatch and rebuild rather than to
 * ask the user to remember.
 */
const SCHEMA_VERSION = 2

export interface RunMeta {
  runId: string
  scenario: string
  capMode: string
  seed: number
  years: number
  params: Record<string, unknown>
  population: Record<string, unknown>
  /** The `DeepPartial<GameConfig>` override this run was given, verbatim. Without it a row
   *  cannot be traced back to the parameters that produced it once the sweep grids move —
   *  `params` only carries whatever the scenario chose to name. */
  config?: Record<string, unknown>
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
  /** Capacity in force this year. */
  abatement: number
  /** Capacity paid for — above `abatement` in the year of an install. */
  abatementCommitted: number
  /** Money charged for capacity bought this year (fee + the new slice). */
  abatementSpend: number
  /** Whether this company installed anything this year — the step count, per year. */
  installed: boolean
  tradedNet: number
  yearCost: number
  optimalCost: number
  /** Cumulative euros of forgone retrofit value — the investment half of the score. */
  investmentGapTotal: number
  /** Baseline-year emission: the divisor that makes both gaps size-neutral. */
  baseline: number
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
  population  TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}'
);

-- What endGame charged, one row per run. Kept out of the years table because it is not a
-- year: the closing happens once, after the last settlement, and its halves are asymmetric.
CREATE TABLE IF NOT EXISTS finals (
  run_id            TEXT PRIMARY KEY,
  final_price       REAL,
  stranded_credits  REAL, stranded_value REAL,
  settled_debt      REAL, settled_debt_cost REAL,
  class_score       REAL, class_optimal_score REAL, excess_over_optimal REAL,
  student_score     REAL, bot_score REAL,
  players_stranded  INTEGER, players_in_debt INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
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
  efficient_price_sr REAL, efficient_price_lr REAL,
  auction_price      REAL, auction_awarded REAL, auction_bid_qty REAL,
  issuance           REAL, shortage_ratio REAL, supply_ratio REAL,
  price_over_penalty REAL,
  reserve_pot        REAL, reserve_released REAL, reserve_revenue REAL,
  reserve_share      REAL,
  mm_inventory       REAL, banked_surplus REAL, banked_debt REAL,
  volume             REAL, trade_count INTEGER,
  free_allocation    REAL, regulator_pool REAL,
  total_expected     REAL, total_realized REAL, total_abated REAL,
  abatement_in_force REAL, abatement_committed REAL,
  abatement_spend    REAL, install_count INTEGER,
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
  abatement REAL, abatement_committed REAL, abatement_spend REAL, installed INTEGER,
  traded_net REAL, year_cost REAL, optimal_cost REAL,
  investment_gap_total REAL, baseline REAL,
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

-- The price PATH, averaged across seeds. The calibration target is a shape, not a mean, and
-- a mean over a run hides whether the market started cheap and tightened or simply collapsed.
CREATE VIEW IF NOT EXISTS v_price_path AS
  SELECT r.scenario, r.cap_mode, r.params, y.year, COUNT(*) AS seeds,
         ROUND(AVG(y.vwap), 2) AS vwap,
         ROUND(AVG(y.price_over_penalty), 3) AS price_over_penalty,
         ROUND(AVG(y.efficient_price_lr), 2) AS efficient_price,
         ROUND(AVG(y.supply_ratio), 3) AS supply_ratio,
         ROUND(AVG(y.ceiling_frac), 3) AS ceiling_frac,
         ROUND(AVG(y.reserve_share), 3) AS reserve_share,
         ROUND(AVG(y.mm_inventory), 1) AS mm_inventory
  FROM years y JOIN runs r USING (run_id)
  GROUP BY r.scenario, r.cap_mode, r.params, y.year;

-- Whether the price came from scarcity or from the fine. A gap_to_efficient near zero means
-- the market found the fundamental answer; a ceiling_frac above zero means it did not.
CREATE VIEW IF NOT EXISTS v_anchor_check AS
  SELECT r.scenario, r.cap_mode, r.params, COUNT(*) AS n,
         ROUND(AVG(y.vwap), 2) AS vwap,
         ROUND(AVG(y.price_over_penalty), 3) AS price_over_penalty,
         ROUND(AVG(y.vwap - y.efficient_price_lr), 2) AS gap_to_efficient,
         ROUND(AVG(y.ceiling_frac), 3) AS ceiling_frac,
         ROUND(AVG(y.abatement_in_force), 3) AS abatement_in_force
  FROM years y JOIN runs r USING (run_id)
  WHERE y.vwap IS NOT NULL
  GROUP BY r.scenario, r.cap_mode, r.params;

-- What hoarding cost the class. A non-zero stranded_value is allowances that were bought,
-- never sold, and then expired worthless under the shipped endgame.
CREATE VIEW IF NOT EXISTS v_endgame AS
  SELECT r.scenario, r.cap_mode, COUNT(*) AS n,
         ROUND(AVG(f.final_price), 2) AS avg_final_price,
         ROUND(AVG(f.stranded_credits), 1) AS avg_stranded_credits,
         ROUND(AVG(f.stranded_value), 1) AS avg_stranded_value,
         ROUND(AVG(f.settled_debt_cost), 1) AS avg_settled_debt_cost,
         ROUND(AVG(f.excess_over_optimal), 1) AS avg_excess_over_optimal
  FROM finals f JOIN runs r USING (run_id)
  GROUP BY r.scenario, r.cap_mode;
`

export class SimDb {
  private db: DatabaseSync

  /** True when the constructor found a stale schema and rebuilt the file. */
  readonly rebuilt: boolean

  constructor(path: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    const found = (
      this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined
    )?.value
    // A file written by an older harness has the old columns and will never gain the new
    // ones. Rebuild it rather than write half the metrics into a table that cannot hold them.
    this.rebuilt = found !== undefined && Number(found) !== SCHEMA_VERSION
    if (this.rebuilt) this.dropAll()
    this.db.exec(SCHEMA)
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
      .run(String(SCHEMA_VERSION))
  }

  private dropAll() {
    for (const v of ['v_price_by_scenario', 'v_depth_by_scenario', 'v_efficiency_by_behaviour',
                     'v_price_path', 'v_anchor_check', 'v_endgame']) {
      this.db.exec(`DROP VIEW IF EXISTS ${v}`)
    }
    for (const t of ['trades', 'players', 'finals', 'years', 'runs']) {
      this.db.exec(`DROP TABLE IF EXISTS ${t}`)
    }
  }

  /** Drops every recorded run, keeping the schema. */
  reset() {
    for (const t of ['trades', 'players', 'finals', 'years', 'runs']) {
      this.db.exec(`DELETE FROM ${t}`)
    }
  }

  insertRun(meta: RunMeta) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs
           (run_id, ts, scenario, cap_mode, seed, years, params, population, config)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(meta.config ?? {}),
      )
  }

  insertFinal(runId: string, f: FinalMetrics) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO finals (
           run_id, final_price, stranded_credits, stranded_value,
           settled_debt, settled_debt_cost,
           class_score, class_optimal_score, excess_over_optimal,
           student_score, bot_score, players_stranded, players_in_debt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId, f.finalPrice, f.strandedCredits, f.strandedValue,
        f.settledDebt, f.settledDebtCost,
        f.classScore, f.classOptimalScore, f.excessOverOptimal,
        f.studentScore, f.botScore, f.playersStranded, f.playersInDebt,
      )
  }

  insertYear(runId: string, year: number, m: YearMetrics) {
    // Columns are named explicitly. This used to be a bare `INSERT INTO years VALUES (?×28)`,
    // which silently coupled argument order to the DDL — adding a metric in the middle of
    // YearMetrics would have written every later value into the wrong column.
    this.db
      .prepare(
        `INSERT OR REPLACE INTO years (
           run_id, year,
           vwap, last_price, price_min, price_max, price_stdev, ceiling_frac,
           efficient_price, price_vs_efficient,
           efficient_price_sr, efficient_price_lr,
           spread_mean, depth_mean, one_sided_frac,
           order_to_trade, fill_rate, price_impact,
           bot_volume_share, unfilled_demand,
           auction_price, auction_awarded, auction_bid_qty, issuance, shortage_ratio,
           supply_ratio, price_over_penalty,
           reserve_pot, reserve_released, reserve_revenue, reserve_share,
           mm_inventory, banked_surplus, banked_debt,
           volume, trade_count,
           free_allocation, regulator_pool,
           total_expected, total_realized, total_abated,
           abatement_in_force, abatement_committed, abatement_spend, install_count,
           total_penalty, class_cost, optimal_cost
         ) VALUES (
           ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, ?,
           ?, ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?,
           ?, ?,
           ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?)`,
      )
      .run(
        runId, year,
        m.vwap, m.lastPrice, m.priceMin, m.priceMax, m.priceStdev, m.ceilingFrac,
        m.efficientPrice, m.priceVsEfficient,
        m.efficientPriceSR, m.efficientPriceLR,
        m.spreadMean, m.depthMean, m.oneSidedFrac,
        m.orderToTrade, m.fillRate, m.priceImpact,
        m.botVolumeShare, m.unfilledDemand,
        m.auctionPrice, m.auctionAwarded, m.auctionBidQty, m.issuance, m.shortageRatio,
        m.supplyRatio, m.priceOverPenalty,
        m.reservePot, m.reserveReleased, m.reserveRevenue, m.reserveShare,
        m.mmInventory, m.bankedSurplus, m.bankedDebt,
        m.volume, m.tradeCount,
        m.freeAllocation, m.regulatorPool,
        m.totalExpected, m.totalRealized, m.totalAbated,
        m.abatementInForceMean, m.abatementCommittedMean, m.abatementSpend, m.installCount,
        m.totalPenalty, m.classCost, m.optimalCost,
      )
  }

  insertPlayers(runId: string, year: number, rows: PlayerRow[]) {
    // Columns named explicitly, for the same reason the years insert names them: a bare
    // positional VALUES couples argument order to the DDL, so inserting a column in the
    // middle writes every later value into the wrong place, silently.
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO players (
         run_id, year, player_id, behaviour, industry, is_bot, bot_type,
         free_allocation, regulator_granted, held, realized,
         abatement, abatement_committed, abatement_spend, installed,
         traded_net, year_cost, optimal_cost, investment_gap_total, baseline
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) {
      stmt.run(
        runId, year, r.playerId, r.behaviour, r.industry, r.isBot ? 1 : 0, r.botType,
        r.freeAllocation, r.regulatorGranted, r.held, r.realized,
        r.abatement, r.abatementCommitted, r.abatementSpend, r.installed ? 1 : 0,
        r.tradedNet, r.yearCost, r.optimalCost, r.investmentGapTotal, r.baseline,
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

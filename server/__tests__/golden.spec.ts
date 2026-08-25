import { describe, expect, it } from 'vitest'
import { Session } from '../session'
import { hostSnapshot } from '../views'

/**
 * CHARACTERIZATION TEST — pins the literal output of the engine as it is today.
 *
 * The rest of the suite deliberately asserts invariants computed from state rather than
 * seed-dependent numbers, which makes it robust but blind: it would not notice
 * `freeCreditRatio` silently becoming 0.75, an extra `rng` draw reordering every
 * generated history, or a rounding rule moving by 0.05. This file exists to notice.
 *
 * These numbers have no meaning of their own — they are simply what the engine produced
 * before the configuration refactor. If a change here is intentional, re-record with
 * `vitest -u` and say so in the commit; if it is not, something moved that should not have.
 */

const PLAYERS: [string, Parameters<Session['addPlayer']>[1]][] = [
  ['Alice', 'Power & Utilities'],
  ['Bob', 'Transport'],
  ['Cara', 'Heavy Materials'],
]

function seeded(mode: 'grandfathering' | 'benchmarking' | 'auctioning') {
  const s = new Session(mode, 1)
  for (const [name, industry] of PLAYERS) s.addPlayer(name, industry)
  return s
}

/** Drives one year with fixed, deterministic player actions (no bots, no RNG of our own). */
function playYear(s: Session, first: boolean) {
  if (first) s.startYear()
  else s.advanceYear()

  if (s.usesAuction) {
    s.submitBid('P1', 900, 70)
    s.submitBid('P2', 300, 45)
    s.submitBid('P3', 700, 55)
  }
  s.closeCapStage()
  s.openTrade()
  // Abatement is a LIFETIME budget, so the two years must ask for different levels or the
  // second year is a silent no-op that pins nothing. Year 12 tops both companies up: a
  // genuine second step, and therefore a second retrofit fee — which is exactly the
  // arithmetic most likely to break unnoticed. Levels stay under `abatement.lifetimeCap`
  // so nothing here is silently clamped to a number nobody chose.
  s.setAbatement('P1', first ? 0.2 : 0.35)
  s.setAbatement('P3', first ? 0.1 : 0.3)
  // 8, not 40. Under the lag nobody's year-11 cut applies in year 11, so the class ends
  // that year far shorter than it used to; by year 12 a benchmarking company's make-good
  // debt has eaten nearly all of its allocation and it can only offer single digits. A
  // fixed size that every mode can actually fill keeps this a characterization test rather
  // than a no-shorting test.
  s.placeOrder('P1', 'sell', 8, 60)
  s.placeOrder('P3', 'buy', 8, 60) // crosses → one trade at the resting price
  s.closeTrade()
}

function capture(s: Session) {
  const rec = s.currentYearRecord()!
  return {
    freeAllocation: rec.freeAllocation,
    regulatorPool: rec.regulatorPool,
    primaryPrice: rec.primaryPrice,
    auctionPrice: rec.auctionPrice,
    regulatorGranted: rec.regulatorGranted,
    realized: rec.realized,
    settlement: rec.settlement,
    netPosition: rec.netPosition,
    // The three abatement numbers, so the lag itself is characterized: `abatement` is what
    // is cutting THIS year, `committed` what has been paid for, `spend` what it cost.
    abatement: rec.abatement,
    abatementCommitted: Object.fromEntries(
      s.state.players.map((p) => [p.id, p.abatementCommitted]),
    ),
    abatementSpend: rec.abatementSpend,
    banked: Object.fromEntries(s.state.players.map((p) => [p.id, p.bankedCredits])),
    score: Object.fromEntries(s.state.players.map((p) => [p.id, p.score])),
    optimalScore: Object.fromEntries(s.state.players.map((p) => [p.id, p.optimalScore])),
  }
}

describe('golden — grandfathering', () => {
  it('year 11 and 12 settle to fixed numbers', () => {
    const s = seeded('grandfathering')
    playYear(s, true)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "abatement": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "abatementCommitted": {
          "P1": 0.2,
          "P2": 0,
          "P3": 0.1,
        },
        "abatementSpend": {
          "P1": 5627,
          "P3": 6114.4,
        },
        "auctionPrice": null,
        "banked": {
          "P1": -229.1,
          "P2": -14,
          "P3": -131.1,
        },
        "freeAllocation": {
          "P1": 911,
          "P2": 174.8,
          "P3": 771.8,
        },
        "netPosition": {
          "P1": 229.1,
          "P2": 14,
          "P3": 131.1,
        },
        "optimalScore": {
          "P1": 18491,
          "P2": 2610,
          "P3": 18504.4,
        },
        "primaryPrice": 50,
        "realized": {
          "P1": 1132.1,
          "P2": 188.8,
          "P3": 910.9,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 28057,
          "P2": 1400,
          "P3": 19704.4,
        },
        "settlement": {
          "P1": {
            "abatementCost": 5627,
            "penaltyCost": 22910,
            "purchaseCost": 0,
            "sellIncome": 480,
            "shortage": 229.1,
            "yearCost": 28057,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 1400,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 14,
            "yearCost": 1400,
          },
          "P3": {
            "abatementCost": 6114.4,
            "penaltyCost": 13110,
            "purchaseCost": 480,
            "sellIncome": 0,
            "shortage": 131.1,
            "yearCost": 19704.4,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "abatement": {
          "P1": 0.2,
          "P2": 0,
          "P3": 0.1,
        },
        "abatementCommitted": {
          "P1": 0.35,
          "P2": 0,
          "P3": 0.3,
        },
        "abatementSpend": {
          "P1": 6888.7,
          "P3": 14220.1,
        },
        "auctionPrice": null,
        "banked": {
          "P1": -356.7,
          "P2": -30.2,
          "P3": -257,
        },
        "freeAllocation": {
          "P1": 911.8,
          "P2": 172.7,
          "P3": 773.1,
        },
        "netPosition": {
          "P1": 356.7,
          "P2": 30.2,
          "P3": 257,
        },
        "optimalScore": {
          "P1": 38759.7,
          "P2": 4416,
          "P3": 43392.5,
        },
        "primaryPrice": 60,
        "realized": {
          "P1": 1031.4,
          "P2": 188.9,
          "P3": 907,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 70135.7,
          "P2": 4420,
          "P3": 60104.5,
        },
        "settlement": {
          "P1": {
            "abatementCost": 6888.7,
            "penaltyCost": 35670,
            "purchaseCost": 0,
            "sellIncome": 480,
            "shortage": 356.7,
            "yearCost": 42078.7,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 3020,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 30.2,
            "yearCost": 3020,
          },
          "P3": {
            "abatementCost": 14220.1,
            "penaltyCost": 25700,
            "purchaseCost": 480,
            "sellIncome": 0,
            "shortage": 257,
            "yearCost": 40400.1,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 1857.6,
          "totalRealized": 2231.8,
          "year": 11,
        },
        {
          "cap": 1857.6,
          "totalRealized": 2127.3,
          "year": 12,
        },
      ]
    `)
  })
})

describe('golden — benchmarking', () => {
  it('year 11 and 12 settle to fixed numbers', () => {
    const s = seeded('benchmarking')
    playYear(s, true)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "abatement": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "abatementCommitted": {
          "P1": 0.2,
          "P2": 0,
          "P3": 0.1,
        },
        "abatementSpend": {
          "P1": 5627,
          "P3": 6114.4,
        },
        "auctionPrice": null,
        "banked": {
          "P1": -540.1,
          "P2": -8.8,
          "P3": -422.9,
        },
        "freeAllocation": {
          "P1": 600,
          "P2": 180,
          "P3": 480,
        },
        "netPosition": {
          "P1": 540.1,
          "P2": 8.8,
          "P3": 422.9,
        },
        "optimalScore": {
          "P1": 37151,
          "P2": 2298,
          "P3": 36012.4,
        },
        "primaryPrice": 50,
        "realized": {
          "P1": 1132.1,
          "P2": 188.8,
          "P3": 910.9,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 59157,
          "P2": 880,
          "P3": 48884.4,
        },
        "settlement": {
          "P1": {
            "abatementCost": 5627,
            "penaltyCost": 54010,
            "purchaseCost": 0,
            "sellIncome": 480,
            "shortage": 540.1,
            "yearCost": 59157,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 880,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 8.8,
            "yearCost": 880,
          },
          "P3": {
            "abatementCost": 6114.4,
            "penaltyCost": 42290,
            "purchaseCost": 480,
            "sellIncome": 0,
            "shortage": 422.9,
            "yearCost": 48884.4,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "abatement": {
          "P1": 0.2,
          "P2": 0,
          "P3": 0.1,
        },
        "abatementCommitted": {
          "P1": 0.35,
          "P2": 0,
          "P3": 0.3,
        },
        "abatementSpend": {
          "P1": 6888.7,
          "P3": 14220.1,
        },
        "auctionPrice": null,
        "banked": {
          "P1": -1009.5,
          "P2": -26.7,
          "P3": -865.9,
        },
        "freeAllocation": {
          "P1": 570,
          "P2": 171,
          "P3": 456,
        },
        "netPosition": {
          "P1": 1009.5,
          "P2": 26.7,
          "P3": 865.9,
        },
        "optimalScore": {
          "P1": 96587.7,
          "P2": 3894,
          "P3": 97434.5,
        },
        "primaryPrice": 60,
        "realized": {
          "P1": 1031.4,
          "P2": 188.9,
          "P3": 907,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 166515.7,
          "P2": 3550,
          "P3": 150174.5,
        },
        "settlement": {
          "P1": {
            "abatementCost": 6888.7,
            "penaltyCost": 100950,
            "purchaseCost": 0,
            "sellIncome": 480,
            "shortage": 1009.5,
            "yearCost": 107358.7,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 2670,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 26.7,
            "yearCost": 2670,
          },
          "P3": {
            "abatementCost": 14220.1,
            "penaltyCost": 86590,
            "purchaseCost": 480,
            "sellIncome": 0,
            "shortage": 865.9,
            "yearCost": 101290.1,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 1260,
          "totalRealized": 2231.8,
          "year": 11,
        },
        {
          "cap": 1197,
          "totalRealized": 2127.3,
          "year": 12,
        },
      ]
    `)
  })
})

describe('golden — auctioning', () => {
  it('year 11 and 12 settle to fixed numbers', () => {
    const s = seeded('auctioning')
    playYear(s, true)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "abatement": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "abatementCommitted": {
          "P1": 0.2,
          "P2": 0,
          "P3": 0.1,
        },
        "abatementSpend": {
          "P1": 5627,
          "P3": 6114.4,
        },
        "auctionPrice": 45,
        "banked": {
          "P1": -240.1,
          "P2": 111.2,
          "P3": -202.9,
        },
        "freeAllocation": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "netPosition": {
          "P1": 240.1,
          "P2": -111.2,
          "P3": 202.9,
        },
        "optimalScore": {
          "P1": 19151,
          "P2": -4902,
          "P3": 22812.4,
        },
        "primaryPrice": 45,
        "realized": {
          "P1": 1132.1,
          "P2": 188.8,
          "P3": 910.9,
        },
        "regulatorGranted": {
          "P1": 900,
          "P2": 300,
          "P3": 700,
        },
        "regulatorPool": 2322,
        "score": {
          "P1": 69657,
          "P2": 13500,
          "P3": 58384.4,
        },
        "settlement": {
          "P1": {
            "abatementCost": 5627,
            "penaltyCost": 24010,
            "purchaseCost": 40500,
            "sellIncome": 480,
            "shortage": 240.1,
            "yearCost": 69657,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 0,
            "purchaseCost": 13500,
            "sellIncome": 0,
            "shortage": 0,
            "yearCost": 13500,
          },
          "P3": {
            "abatementCost": 6114.4,
            "penaltyCost": 20290,
            "purchaseCost": 31980,
            "sellIncome": 0,
            "shortage": 202.9,
            "yearCost": 58384.4,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "abatement": {
          "P1": 0.2,
          "P2": 0,
          "P3": 0.1,
        },
        "abatementCommitted": {
          "P1": 0.35,
          "P2": 0,
          "P3": 0.3,
        },
        "abatementSpend": {
          "P1": 6888.7,
          "P3": 14220.1,
        },
        "auctionPrice": 45,
        "banked": {
          "P1": -379.5,
          "P2": 222.3,
          "P3": -401.9,
        },
        "freeAllocation": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "netPosition": {
          "P1": 379.5,
          "P2": -222.3,
          "P3": 401.9,
        },
        "optimalScore": {
          "P1": 40787.7,
          "P2": -18246,
          "P3": 56394.5,
        },
        "primaryPrice": 45,
        "realized": {
          "P1": 1031.4,
          "P2": 188.9,
          "P3": 907,
        },
        "regulatorGranted": {
          "P1": 900,
          "P2": 300,
          "P3": 700,
        },
        "regulatorPool": 2205.9,
        "score": {
          "P1": 154515.7,
          "P2": 27000,
          "P3": 144774.5,
        },
        "settlement": {
          "P1": {
            "abatementCost": 6888.7,
            "penaltyCost": 37950,
            "purchaseCost": 40500,
            "sellIncome": 480,
            "shortage": 379.5,
            "yearCost": 84858.7,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 0,
            "purchaseCost": 13500,
            "sellIncome": 0,
            "shortage": 0,
            "yearCost": 13500,
          },
          "P3": {
            "abatementCost": 14220.1,
            "penaltyCost": 40190,
            "purchaseCost": 31980,
            "sellIncome": 0,
            "shortage": 401.9,
            "yearCost": 86390.1,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 2322,
          "totalRealized": 2231.8,
          "year": 11,
        },
        {
          "cap": 2205.9,
          "totalRealized": 2127.3,
          "year": 12,
        },
      ]
    `)
  })
})

describe('golden — generated histories', () => {
  it('the seeded emission histories are exactly these', () => {
    const s = seeded('grandfathering')
    expect(s.state.players.map((p) => ({ id: p.id, emissions: p.emissions }))).toMatchInlineSnapshot(`
      [
        {
          "emissions": {
            "1": 1040.9,
            "10": 1125.4,
            "2": 1005,
            "3": 1048.4,
            "4": 1096.2,
            "5": 1031.1,
            "6": 1061.6,
            "7": 1080.8,
            "8": 1077.3,
            "9": 1080.5,
          },
          "id": "P1",
        },
        {
          "emissions": {
            "1": 198,
            "10": 218.3,
            "2": 181.1,
            "3": 204.9,
            "4": 202,
            "5": 193.3,
            "6": 204.3,
            "7": 208.6,
            "8": 214.4,
            "9": 218.4,
          },
          "id": "P2",
        },
        {
          "emissions": {
            "1": 826.5,
            "10": 978.3,
            "2": 860.6,
            "3": 864,
            "4": 854.7,
            "5": 906.8,
            "6": 911.6,
            "7": 914.3,
            "8": 914.6,
            "9": 989.2,
          },
          "id": "P3",
        },
      ]
    `)
  })

  it('the trader-bot seed and its price are exactly these', () => {
    const s = new Session('benchmarking', 7)
    s.addPlayer('Human', 'Power & Utilities')
    const mm = s.addBot('marketMaker')
    const spec = s.addBot('speculator')
    s.addBot('compliance')
    s.startYear()
    const rec = s.currentYearRecord()!
    expect({
      primaryPrice: rec.primaryPrice,
      seed: { mm: rec.regulatorGranted[mm.id], spec: rec.regulatorGranted[spec.id] },
      freeAllocation: rec.freeAllocation,
      circulatingCap: s.circulatingCap(),
    }).toMatchInlineSnapshot(`
      {
        "circulatingCap": 1200,
        "freeAllocation": {
          "P1": 600,
          "P2": 0,
          "P3": 0,
          "P4": 600,
        },
        "primaryPrice": 50,
        "seed": {
          "mm": 216,
          "spec": 20,
        },
      }
    `)
  })
})

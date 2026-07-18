import type { Player } from '../../types'

/**
 * Three players transcribed by hand from the designer's own notebook output
 * (Renjie/game_design/players_20260709_025259.xlsx — read-only reference).
 * Class-level totals published in that file / the notebook:
 *   total baseline (Σ Year_10) = 28332.7  → free credit limit = 22666.2
 *   total past ten-year emissions        = 268479.7
 * Expected grandfathering allocations for Year 11: P1=186.8, P2=1036.6, P3=441.8.
 */
export const XLSX_CLASS_TOTALS = {
  totalBaseline: 28332.7,
  freeCreditLimit: 22666.2,
  totalPastTenYears: 268479.7,
}

function player(
  id: string,
  industry: Player['industry'],
  yearsDescending: number[], // Year_10 → Year_1
): Player {
  const emissions: Record<number, number> = {}
  yearsDescending.forEach((value, i) => {
    emissions[10 - i] = value
  })
  return { id, name: id, industry, emissions, connected: true, score: 0 }
}

export const XLSX_PLAYERS: {
  player: Player
  pastTenYears: number
  expectedAllocation: number
}[] = [
  {
    player: player('P1', 'Transport', [231.9, 248.6, 231.1, 222.1, 218.6, 217.7, 213.5, 213.6, 210.3, 205.8]),
    pastTenYears: 2213.2,
    expectedAllocation: 186.8,
  },
  {
    player: player('P2', 'Power & Utilities', [1312.1, 1278.4, 1256.7, 1252.7, 1246.2, 1194, 1207.1, 1182.8, 1204.9, 1144.1]),
    pastTenYears: 12279,
    expectedAllocation: 1036.6,
  },
  {
    player: player('P3', 'Manufacturing & Chemicals', [535.5, 541.3, 526.1, 524.8, 510.9, 507.6, 530.9, 537.6, 505, 513.4]),
    pastTenYears: 5233.1,
    expectedAllocation: 441.8,
  },
]

export const DEFAULT_CONFIG = {
  freeCreditRatio: 0.8,
  historyWindow: 10,
  baselineYear: 10,
  regulatorPrice: 10,
  penaltyRate: 20,
  benchmark: {
    'Power & Utilities': 800,
    'Heavy Materials': 640,
    'Manufacturing & Chemicals': 420,
    Transport: 240,
  },
}

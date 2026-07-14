import { describe, expect, it } from 'vitest'
import { INDUSTRIES } from '../../constants'
import { realizeYear } from '../emissions'
import { createRng } from '../rng'
import { XLSX_PLAYERS } from './fixtures'

describe('realizeYear', () => {
  it('draws each player uniform within their industry range, 1 decimal place', () => {
    const players = XLSX_PLAYERS.map((f) => f.player)
    const rng = createRng(1)
    for (let i = 0; i < 200; i++) {
      const realized = realizeYear(players, rng)
      for (const p of players) {
        const { low, high } = INDUSTRIES[p.industry]
        expect(realized[p.id]).toBeGreaterThanOrEqual(low)
        expect(realized[p.id]).toBeLessThanOrEqual(high)
        expect(realized[p.id]).toBeCloseTo(Math.round(realized[p.id] * 10) / 10, 10)
      }
    }
  })
})

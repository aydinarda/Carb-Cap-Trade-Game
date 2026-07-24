import { describe, expect, it } from 'vitest'
import { EMISSION_VOLATILITY } from '../../constants'
import { expectedEmission, realizeYear } from '../emissions'
import { createRng } from '../rng'
import { XLSX_PLAYERS } from './fixtures'

describe('expectedEmission', () => {
  it('is the most recent known level (baseline Year 10 for the first game year)', () => {
    for (const { player } of XLSX_PLAYERS) {
      expect(expectedEmission(player, 11)).toBe(Math.round(player.emissions[10] * 10) / 10)
    }
  })

  it('follows the previous realized year afterwards (random walk)', () => {
    const { player } = XLSX_PLAYERS[0]
    const withY11 = { ...player, emissions: { ...player.emissions, 11: 222.2 } }
    expect(expectedEmission(withY11, 12)).toBe(222.2)
  })
})

describe('realizeYear', () => {
  it('draws around each company mean within a few standard deviations', () => {
    const players = XLSX_PLAYERS.map((f) => f.player)
    const rng = createRng(1)
    for (let i = 0; i < 200; i++) {
      const realized = realizeYear(players, rng, 11)
      for (const p of players) {
        const mean = expectedEmission(p, 11)
        // realized is a normal draw around the mean; stay within ±5σ and ≥ 0
        expect(realized[p.id]).toBeGreaterThanOrEqual(0)
        expect(Math.abs(realized[p.id] - mean)).toBeLessThan(5 * EMISSION_VOLATILITY * mean)
        expect(realized[p.id]).toBeCloseTo(Math.round(realized[p.id] * 10) / 10, 10)
      }
    }
  })

  it('averages close to the mean over many draws', () => {
    const [{ player }] = XLSX_PLAYERS
    const rng = createRng(7)
    const mean = expectedEmission(player, 11)
    let sum = 0
    const n = 4000
    for (let i = 0; i < n; i++) sum += realizeYear([player], rng, 11)[player.id]
    expect(sum / n).toBeCloseTo(mean, 0)
  })

  it('abatement lowers the mean by the chosen fraction', () => {
    const [{ player }] = XLSX_PLAYERS
    const rng = createRng(3)
    const mean = expectedEmission(player, 11)
    let sum = 0
    const n = 4000
    for (let i = 0; i < n; i++) sum += realizeYear([player], rng, 11, { [player.id]: 0.4 })[player.id]
    expect(sum / n).toBeCloseTo(mean * 0.6, 0)
  })
})

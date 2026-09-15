import { describe, expect, it } from 'vitest'
import type { RlModelInfo } from '../../shared/types'
import { RlAgentManager, type ModelSource } from '../rl/manager'
import { getModel, listModels, modelFromFile, Policy, type LoadedModel } from '../rl/models'
import { featuresFor, type RlMode } from '../rl/observe'
import { Session } from '../session'
import { hostSnapshot } from '../views'

const f32 = (xs: number[]) => Buffer.from(new Float32Array(xs).buffer).toString('base64')
const f64 = (xs: number[]) => Buffer.from(new Float64Array(xs).buffer).toString('base64')

function usableHybrid(): RlModelInfo {
  const model = listModels().find((m) => m.error === null && m.mode === 'hybrid')
  if (!model) throw new Error('no usable hybrid model in server/rl/models')
  return model
}

describe('RL model files', () => {
  it('every shipped model matches this server and reproduces its exported actions', () => {
    const models = listModels()
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) expect(model.error, model.id).toBeNull()
  })

  it('runs the actor: normalise and clip, tanh hidden layer, linear head clipped to ±1', () => {
    const policy = new Policy({
      normalizer: { mean: f64([1, -1]), var: f64([4, 1]), clip: 10, epsilon: 0 },
      layers: [
        { in: 2, out: 2, activation: 'tanh', weight: f32([1, 0, 0, 1]), bias: f32([0, 0]) },
        { in: 2, out: 4, activation: 'linear', weight: f32([1, 0, 0, 1, 2, 0, 0, -5]), bias: f32([0, 0, 0, 0]) },
      ],
    })
    // (3 − 1)/2 = 1 and (0 + 1)/1 = 1 → tanh(1) on both.
    const t = Math.tanh(1)
    const action = policy.act([3, 0])
    expect(action[0]).toBeCloseTo(t, 6)
    expect(action[1]).toBeCloseTo(t, 6)
    expect(action[2]).toBe(1)
    expect(action[3]).toBe(-1)
  })

  it('refuses a model whose feature list has drifted from this copy of observe.ts', () => {
    const features = featuresFor('hybrid').map((f) => f.name)
    features[5] = 'renamed_feature'
    const model = modelFromFile(
      { format: 1, id: 'drifted', label: 'Drifted', mode: 'hybrid', features, env: { round_seconds: 30, agent_every_seconds: 2 } },
      'drifted',
    )
    expect(model.policy).toBeNull()
    expect(model.info.error).toMatch(/drifted/)
  })
})

describe('RL agents in a game', () => {
  it('joins as an ordinary company, only in the lobby and only in the mode it was trained for', () => {
    const manager = new RlAgentManager()
    const s = new Session('hybrid', 1)
    const model = usableHybrid()

    const added = manager.add(s, model.id, 2, 'Transport')
    expect(s.state.players).toHaveLength(2)
    for (const player of added) {
      expect(player.isBot).toBeFalsy()
      expect(player.agentModel).toBe(model.id)
      expect(player.industry).toBe('Transport')
    }
    expect(hostSnapshot(s).players.map((row) => row.agentModel)).toEqual([model.id, model.id])

    s.setCapMode('auctioning')
    expect(() => manager.add(s, model.id)).toThrow(/trained for hybrid/)
    s.setCapMode('hybrid')
    expect(() => manager.add(s, 'no-such-model')).toThrow(/Unknown agent model/)
    s.startYear()
    expect(() => manager.add(s, model.id)).toThrow(/lobby/)
  })

  it('plays a round on its trained clock: one bid, 15 trades, then the abatement decision', () => {
    const manager = new RlAgentManager()
    const s = new Session('hybrid', 3)
    s.addPlayer('Alice', 'Heavy Materials')
    s.addBot('compliance')
    s.addBot('compliance')
    s.addBot('marketMaker')
    manager.add(s, usableHybrid().id)

    let now = 0
    const run = (ms: number) => {
      const end = now + ms
      while (now < end) {
        now += 250
        manager.tick(now)
      }
    }
    const stats = () => manager.statsFor(s)[0].stats

    s.startYear()
    run(1_000)
    expect(stats().bids).toBe(1)

    s.closeCapStage()
    s.openTrade()
    run(31_000)
    expect(stats()).toMatchObject({ bids: 1, trades: 15, abatements: 1, errors: 0 })
    run(10_000)
    expect(stats().trades).toBe(15)

    s.closeTrade()
    run(500)
    s.advanceYear()
    run(1_000)
    expect(stats()).toMatchObject({ bids: 2, errors: 0 })
  })

  it('stops playing once kicked from the lobby', () => {
    const manager = new RlAgentManager()
    const s = new Session('hybrid', 2)
    const [agent] = manager.add(s, usableHybrid().id)
    s.kickPlayer(agent.id)
    manager.tick(1)
    expect(manager.statsFor(s)).toEqual([])
  })
})

/** A valid model that always holds: zero weights, so its actions are all 0. */
function zeroModel(id: string, mode: RlMode): LoadedModel {
  const features = featuresFor(mode).map((f) => f.name)
  const n = features.length
  return modelFromFile(
    {
      format: 1,
      id,
      label: id,
      mode,
      features,
      env: { round_seconds: 30, agent_every_seconds: 2 },
      source: { which: 'final', steps_trained: 0 },
      normalizer: { mean: f64(new Array(n).fill(0)), var: f64(new Array(n).fill(1)), clip: 10, epsilon: 0 },
      layers: [{ in: n, out: 4, activation: 'linear', weight: f32(new Array(n * 4).fill(0)), bias: f32([0, 0, 0, 0]) }],
      check: { obs: [new Array(n).fill(0)], action: [[0, 0, 0, 0]] },
    },
    id,
  )
}

/** Exactly these models, so a model added to server/rl/models later cannot change the outcome. */
function sourceOf(...models: LoadedModel[]): ModelSource {
  const byId = new Map(models.map((m) => [m.info.id, m]))
  return { getModel: (id) => byId.get(id), listModels: () => models.map((m) => m.info) }
}

describe('RL agents follow the room mode', () => {
  it('in the lobby, switching the mode removes the agents trained for another one', () => {
    const manager = new RlAgentManager()
    const s = new Session('hybrid', 4)
    s.addPlayer('Alice', 'Transport')
    manager.add(s, usableHybrid().id, 2)

    s.setCapMode('benchmarking')
    expect(manager.reconcile(s)).toEqual({ removed: 2, reseated: 0 })
    expect(s.state.players.map((p) => p.name)).toEqual(['Alice'])
    expect(manager.statsFor(s)).toEqual([])
  })

  it('between years the company stays: re-seated on a model for the new mode, idle without one', () => {
    const home = getModel(usableHybrid().id)!
    const bench = zeroModel('bench-zero', 'benchmarking')
    expect(bench.info.error).toBeNull()
    const manager = new RlAgentManager(sourceOf(home, bench))
    const s = new Session('hybrid', 6)
    s.addBot('compliance')
    s.addBot('compliance')
    s.addBot('marketMaker')
    const [agent] = manager.add(s, home.info.id)

    let now = 0
    const run = (ms: number) => {
      const end = now + ms
      while (now < end) {
        now += 250
        manager.tick(now)
      }
    }
    const playRound = () => {
      run(1_000)
      s.closeCapStage()
      s.openTrade()
      run(31_000)
      s.closeTrade()
      run(500)
    }
    const stats = () => manager.statsFor(s)[0].stats

    s.startYear()
    playRound()
    expect(stats()).toMatchObject({ bids: 1, trades: 15, abatements: 1 })
    // The year summary is where the mode can change, so the host is sent the models there too.
    expect(hostSnapshot(s).rlModels.length).toBeGreaterThan(0)

    s.setCapMode('benchmarking')
    expect(manager.reconcile(s)).toEqual({ removed: 0, reseated: 1 })
    expect(agent.agentModel).toBe('bench-zero')
    s.advanceYear()
    playRound()
    // Benchmarking runs no auction: no new bid, but a full trade window and an abatement decision.
    expect(stats()).toMatchObject({ bids: 1, trades: 30, abatements: 2, errors: 0 })

    s.setCapMode('auctioning')
    expect(manager.reconcile(s)).toEqual({ removed: 0, reseated: 0 })
    s.advanceYear()
    playRound()
    expect(stats()).toMatchObject({ bids: 1, trades: 30, abatements: 2 })

    s.setCapMode('hybrid')
    expect(manager.reconcile(s)).toEqual({ removed: 0, reseated: 1 })
    expect(agent.agentModel).toBe(home.info.id)
    s.advanceYear()
    playRound()
    expect(stats()).toMatchObject({ bids: 2, trades: 45, abatements: 3, errors: 0 })
  })
})

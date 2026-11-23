import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RlModelInfo } from '../../shared/types'
import { decisionOffsets, FIXED_2S_SCHEDULE, RL_STAGE_SCHEDULE } from '../rl/clock'
import { RlAgentManager, type ModelSource } from '../rl/manager'
import { getModel, listModels, modelFromFile, Policy, type LoadedModel } from '../rl/models'
import { featuresFor, type FeatureSet, type RlMode } from '../rl/observe'
import { Session } from '../session'
import { hostSnapshot } from '../views'

const f32 = (xs: number[]) => Buffer.from(new Float32Array(xs).buffer).toString('base64')
const f64 = (xs: number[]) => Buffer.from(new Float64Array(xs).buffer).toString('base64')

/**
 * The models these tests load: one valid zero-weight model per mode, written to a temporary folder
 * and served through `RL_MODELS_DIR`, so the tests never depend on which trained models happen to
 * ship in server/rl/models (none, after the 2026-11-06 clean-up).
 */
const MODELS_DIR = mkdtempSync(path.join(tmpdir(), 'rl-server-models-'))
for (const mode of ['grandfathering', 'benchmarking', 'auctioning', 'hybrid'] as RlMode[]) {
  const features = featuresFor(mode, 1).map((f) => f.name)
  const n = features.length
  writeFileSync(
    path.join(MODELS_DIR, `sifir-${mode}.json`),
    JSON.stringify({
      format: 1, id: `sifir-${mode}`, label: 'sifir', mode, features,
      env: { round_seconds: 30, agent_every_seconds: 2 },
      normalizer: { mean: f64(new Array(n).fill(0)), var: f64(new Array(n).fill(1)), clip: 10, epsilon: 0 },
      layers: [{ in: n, out: 4, activation: 'linear', weight: f32(new Array(n * 4).fill(0)), bias: f32([0, 0, 0, 0]) }],
      check: { obs: [new Array(n).fill(0)], action: [[0, 0, 0, 0]] },
      log_std: [-1, -1, -1, -1],
    }),
  )
}
process.env.RL_MODELS_DIR = MODELS_DIR

function usableHybrid(): RlModelInfo {
  const model = listModels().find((m) => m.error === null && m.mode === 'hybrid')
  if (!model) throw new Error('no usable hybrid model in the test models folder')
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

  it('runs a model trained on feature set 3, which also reads the screening notice', () => {
    const model = zeroModel('screening-aware', 'hybrid', 3)
    expect(model.info.error).toBeNull()
    expect(model.featureSet).toBe(3)
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

  it('plays a round on its schedule: one bid at 2 s, 15 trades by 50 s, then the abatement decision', () => {
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
    run(2_500)
    expect(stats().bids).toBe(1)

    s.closeCapStage()
    s.openTrade()
    run(51_000)
    expect(stats()).toMatchObject({ bids: 1, trades: 15, abatements: 1, errors: 0 })
    run(10_000)
    expect(stats().trades).toBe(15)

    s.closeTrade()
    run(500)
    s.advanceYear()
    run(2_500)
    expect(stats()).toMatchObject({ bids: 2, errors: 0 })
  })

  it('takes its abatement decision when the host closes the market early, and only once', () => {
    const manager = new RlAgentManager()
    const s = new Session('hybrid', 3)
    s.addPlayer('Alice', 'Heavy Materials')
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
    s.closeCapStage()
    s.openTrade()
    run(9_000) // a short market: 4 of the 15 slots
    expect(stats()).toMatchObject({ trades: 4, abatements: 0 })
    expect(manager.finishWindow(s)).toBe(true)
    expect(stats()).toMatchObject({ trades: 4, abatements: 1, errors: 0 })
    expect(manager.finishWindow(s)).toBe(false) // already decided this year
    run(5_000)
    expect(stats().trades).toBe(4) // nothing more once it has abated
    s.closeTrade()

    // A full window: the agent abates after its last slot, and the close adds nothing.
    s.advanceYear()
    run(1_000)
    s.closeCapStage()
    s.openTrade()
    run(51_000)
    expect(stats()).toMatchObject({ trades: 19, abatements: 2 })
    expect(manager.finishWindow(s)).toBe(false)
    expect(stats().abatements).toBe(2)
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

/**
 * The stage schedule (2026-11-23): the host decides how long a stage lasts and the agent cannot
 * know it, so its decisions come 2 s apart five times, then 3 s, then 5 s, from the moment it sees
 * the stage open. A stage that closes early skips the rest; once they are all made it waits.
 */
describe('RL agents decide on the stage schedule', () => {
  /** A hybrid room with one agent, and a virtual clock that ticks the manager every `stepMs`. */
  function room(seed: number, schedule = RL_STAGE_SCHEDULE) {
    const manager = new RlAgentManager(undefined, schedule)
    const s = new Session('hybrid', seed)
    s.addPlayer('Alice', 'Heavy Materials')
    s.addBot('compliance')
    s.addBot('marketMaker')
    const [player] = manager.add(s, usableHybrid().id)
    const clock = { now: 0 }
    const run = (ms: number, stepMs = 250, each?: () => void) => {
      const end = clock.now + ms
      while (clock.now < end) {
        clock.now += stepMs
        manager.tick(clock.now)
        each?.()
      }
    }
    const stats = () => manager.statsFor(s)[0].stats
    return { manager, s, player, clock, run, stats }
  }

  it('lays the decisions at 2, 4, 6, 8, 10, 13, …, 25, 30, …, 50 s', () => {
    expect(decisionOffsets(RL_STAGE_SCHEDULE)).toEqual(
      [2, 4, 6, 8, 10, 13, 16, 19, 22, 25, 30, 35, 40, 45, 50].map((x) => x * 1000),
    )
    expect(decisionOffsets(FIXED_2S_SCHEDULE)).toEqual(Array.from({ length: 15 }, (_, i) => (i + 1) * 2000))
    expect(() => decisionOffsets([{ count: 2, everySeconds: 0 }])).toThrow(/bad schedule/)
    expect(() => decisionOffsets([])).toThrow(/at least one/)
  })

  it('trades at exactly those moments after the market opens, then abates and waits', () => {
    const { s, clock, run, stats } = room(11)
    s.startYear()
    run(2_500)
    s.closeCapStage()
    s.openTrade()
    const opened = clock.now
    const at: number[] = []
    let abatedAt: number | null = null
    run(70_000, 50, () => {
      if (stats().trades > at.length) at.push(clock.now - opened)
      if (abatedAt === null && stats().abatements > 0) abatedAt = clock.now - opened
    })
    // The clock starts at the first poll that sees the market (50 ms here).
    const expected = decisionOffsets(RL_STAGE_SCHEDULE).map((ms) => ms + 50)
    expect(at).toEqual(expected)
    expect(abatedAt).toBe(expected[14]) // straight after the 15th
    expect(stats()).toMatchObject({ trades: 15, abatements: 1, errors: 0 }) // and nothing in the 20 s after
  })

  it('skips the rest when the market closes early, and takes the abatement decision at the close', () => {
    const { manager, s, run, stats } = room(12)
    s.startYear()
    run(2_500)
    s.closeCapStage()
    s.openTrade()
    run(20_000) // 2, 4, 6, 8, 10, 13, 16 and 19 s: 8 of 15
    expect(stats()).toMatchObject({ trades: 8, abatements: 0 })
    expect(manager.finishWindow(s)).toBe(true)
    s.closeTrade()
    run(10_000)
    expect(stats()).toMatchObject({ trades: 8, abatements: 1, errors: 0 })
  })

  it('bids once, 2 s into the cap stage, and not at all if the cap stage closes before then', () => {
    const { s, run, stats } = room(13)
    s.startYear()
    run(1_500)
    expect(stats().bids).toBe(0)
    run(1_000)
    expect(stats().bids).toBe(1)
    run(20_000)
    expect(stats().bids).toBe(1) // one bid per cap stage

    s.closeCapStage()
    s.openTrade()
    run(1_000)
    s.closeTrade()
    s.advanceYear()
    run(1_500) // the host closes this cap stage before the agent's first slot
    s.closeCapStage()
    run(5_000)
    expect(stats().bids).toBe(1)
  })

  it('votes in a referendum 2 s after the vote opens', () => {
    const { s, player, clock, run } = room(14)
    s.startYear()
    run(2_500)
    s.closeCapStage()
    s.openTrade()
    run(1_000)
    s.closeTrade()
    run(500)
    s.openReferendum({ chatSeconds: 5, voteSeconds: 30 }, clock.now)
    run(5_000)
    expect(s.referendumTick(clock.now)).toBe(true) // the chat is over: the vote opens
    expect(s.activeReferendum?.stage).toBe('vote')
    run(1_500)
    expect(s.activeReferendum?.votes[player.id]).toBeUndefined()
    run(1_000)
    expect(s.activeReferendum?.votes[player.id]).toBeDefined()
  })

  it('can still run the old fixed 2 s clock (for comparisons)', () => {
    const { s, run, stats } = room(15, FIXED_2S_SCHEDULE)
    s.startYear()
    run(2_500)
    s.closeCapStage()
    s.openTrade()
    run(31_000)
    expect(stats()).toMatchObject({ bids: 1, trades: 15, abatements: 1, errors: 0 })
  })
})

/** A valid model that always holds: zero weights, so its actions are all 0. */
function zeroModel(id: string, mode: RlMode, set: FeatureSet = 1): LoadedModel {
  const features = featuresFor(mode, set).map((f) => f.name)
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
      run(2_500)
      s.closeCapStage()
      s.openTrade()
      run(51_000)
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

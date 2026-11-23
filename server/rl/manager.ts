import { INDUSTRY_NAMES, type Industry } from '../../shared/constants'
import type { CapMode, Player, RlModelInfo } from '../../shared/types'
import { GameError, type Session, type SessionStore } from '../session'
import { playerSnapshot } from '../views'
import { apply, decode } from './act'
import { decisionOffsets, RL_STAGE_SCHEDULE, type ScheduleSegment } from './clock'
import { createMemory, remember, type Memory } from './memory'
import { getModel, listModels, type LoadedModel, type Policy } from './models'
import { observe, type FeatureSet, type RlMode, type StepKind } from './observe'

/**
 * Plays the RL agents a host added in the lobby.
 *
 * An agent is an ordinary company (`addPlayer`, not `addBot`) because that is what it was trained
 * as: the leaderboard, the class counts and its own memory all see it as a student. It reads
 * exactly the `playerSnapshot` a student's screen receives and acts through the same Session
 * methods the socket handlers call.
 *
 * It decides on a schedule (`clock.ts`, 2026-11-23), because the host decides how long each stage
 * lasts and the agent cannot know it: from the moment it sees a stage open, its decisions fall due
 * 2 s apart five times, then 3 s apart, then 5 s apart (2, 4, …, 10, 13, …, 25, 30, …, 50 s). The
 * cap stage takes the first of them (one sealed bid, at 2 s); the market up to 15 buy/sell
 * decisions, with the abatement decision straight after the last; a referendum's vote stage the
 * first (the vote, by the shared rule). A stage that closes early skips the rest (for the market
 * `finishWindow` still takes the abatement decision at the close), and an agent that has made
 * them all waits for the stage to end. The models were trained on 15 decisions 2 s apart over a
 * 30 s window, with no time in their observation, so they run unchanged on this schedule.
 *
 * A policy only understands the mode it was trained in, and the host can change the mode under
 * it (see `reconcile`): in the lobby the agent is removed; once the game has started the company
 * cannot leave, so another model trained for the new mode takes over, and the agent's own model
 * returns when the room does. With no model for the mode, the company sits the rounds out.
 *
 * rl/live-agent.ts plays the same models over a socket from outside the server, still on the
 * trained 2 s clock.
 */

/** How often the clock is checked; a decision lands within this of when it is due. */
const POLL_MS = 200
/** Most agents one click adds. */
export const MAX_AGENTS_PER_ADD = 10

export interface AgentBroadcast {
  /** Coalesced state push for a room an agent just acted in. */
  schedule(session: Session): void
}

/** Where the manager finds models: `server/rl/models/` on the server; tests hand it their own. */
export interface ModelSource {
  getModel(id: string): LoadedModel | undefined
  listModels(): RlModelInfo[]
}

const DISK: ModelSource = { getModel, listModels }

/** Decisions taken, for tests and diagnostics. */
export interface AgentStats {
  bids: number
  trades: number
  abatements: number
  /** Actions the engine refused (wrong phase, no shorting). Not errors. */
  refused: number
  errors: number
}

interface Agent {
  player: Player
  /** The model the host added. It plays again whenever the room is back in its mode. */
  homeModelId: string
  mode: RlMode
  policy: Policy
  /** The observation its model was trained on; set 2 and later make the borrowing choice too. */
  featureSet: FeatureSet
  memory: Memory
  /** The stage it is deciding in, and how far through the schedule it is. */
  clock: StageClock | null
  settledYear: number | null
  stats: AgentStats
}

/**
 * One stage's decisions. `stage` names it: `<year>:cap`, `<year>:trade` or `vote:<referendum id>`.
 * `startedAt` is the first poll that saw it open; `done` once it will decide nothing more there.
 */
interface StageClock {
  stage: string
  startedAt: number
  count: number
  done: boolean
}

interface Room {
  session: Session
  agents: Agent[]
}

export class RlAgentManager {
  private rooms = new Map<string, Room>()
  private timer?: NodeJS.Timeout
  private store?: SessionStore
  private broadcast?: AgentBroadcast
  /** When each decision of a stage is due, in ms from its start. */
  private readonly offsets: number[]

  /** `schedule`: the live one by default; tests and measurements can pass another (e.g. FIXED_2S_SCHEDULE). */
  constructor(
    private readonly source: ModelSource = DISK,
    schedule: readonly ScheduleSegment[] = RL_STAGE_SCHEDULE,
  ) {
    this.offsets = decisionOffsets(schedule)
  }

  start(store: SessionStore, broadcast: AgentBroadcast) {
    this.store = store
    this.broadcast = broadcast
    if (!this.timer) this.timer = setInterval(() => this.tick(Date.now()), POLL_MS)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Lobby only. Adds `count` companies played by one model; industry is random unless given. */
  add(session: Session, modelId: string, count = 1, industry?: Industry): Player[] {
    if (session.state.phase !== 'lobby') {
      throw new GameError('NOT_LOBBY', 'Agents can only be added in the lobby.')
    }
    const model = this.source.getModel(modelId)
    if (!model) throw new GameError('NO_MODEL', 'Unknown agent model.')
    const { info, policy } = model
    if (!policy) throw new GameError('BAD_MODEL', `${info.label} cannot run on this server: ${info.error}`)
    if (session.state.capMode !== info.mode) {
      throw new GameError(
        'WRONG_MODE',
        `${info.label} was trained for ${info.mode}. Switch the room to ${info.mode} first.`,
      )
    }
    if (industry !== undefined && !INDUSTRY_NAMES.includes(industry)) {
      throw new GameError('BAD_INDUSTRY', 'Please pick an industry.')
    }

    const code = session.state.roomCode
    const room = this.rooms.get(code) ?? { session, agents: [] }
    this.rooms.set(code, room)
    const n = Math.max(1, Math.min(MAX_AGENTS_PER_ADD, Math.floor(count) || 1))
    const added: Player[] = []
    for (let i = 0; i < n; i++) {
      const sameModel = session.state.players.filter((p) => p.agentModel === info.id).length
      // Random by default, as in training: one policy was trained across all four sectors.
      const sector = industry ?? INDUSTRY_NAMES[Math.floor(Math.random() * INDUSTRY_NAMES.length)]
      const { player } = session.addPlayer(`RL ${info.label} ${sameModel + 1}`, sector)
      const agent = {
        player,
        homeModelId: info.id,
        memory: createMemory(),
        clock: null,
        settledYear: null,
        stats: { bids: 0, trades: 0, abatements: 0, refused: 0, errors: 0 },
      } as Agent
      this.seat(agent, model)
      room.agents.push(agent)
      added.push(player)
    }
    return added
  }

  /**
   * Brings a room's agents in line with its mode, after the host changed it.
   *
   * In the lobby an agent trained for another mode is removed. Once the game has started the
   * company cannot leave, so it is re-seated on a model trained for the new mode (its own model,
   * when the room is back in that mode) and keeps its memory; with none, it sits out until the
   * mode comes back. Idempotent: the socket handler calls it straight after the switch, and every
   * tick calls it again in case the mode changed some other way.
   */
  reconcile(session: Session): { removed: number; reseated: number } {
    const result = { removed: 0, reseated: 0 }
    const room = this.roomOf(session)
    const mode = session.state.capMode
    if (!room || mode === null || session.state.phase === 'ended') return result

    for (const agent of [...room.agents]) {
      if (session.state.phase === 'lobby') {
        if (agent.mode === mode) continue
        session.kickPlayer(agent.player.id)
        room.agents.splice(room.agents.indexOf(agent), 1)
        result.removed += 1
        continue
      }
      const wanted = this.modelFor(mode, agent.homeModelId)
      if (wanted && wanted.info.id !== agent.player.agentModel) {
        this.seat(agent, wanted)
        result.reseated += 1
      }
    }
    return result
  }

  /** The agents still in a room, with the model playing each and what they have done. */
  statsFor(session: Session): { playerId: string; model: string | undefined; stats: AgentStats }[] {
    const room = this.roomOf(session)
    if (!room) return []
    return room.agents
      .filter((a) => session.state.players.includes(a.player))
      .map((a) => ({ playerId: a.player.id, model: a.player.agentModel, stats: { ...a.stats } }))
  }

  /** One pass over every room with agents. Public so tests can drive the clock. */
  tick(now: number) {
    for (const [code, room] of this.rooms) {
      const { session } = room
      if (this.store !== undefined && this.store.get(code) !== session) {
        this.rooms.delete(code)
        continue
      }
      // A kicked agent is no longer in the player list; it stops playing with nothing to clean up.
      room.agents = room.agents.filter((a) => session.state.players.includes(a.player))
      const { removed, reseated } = this.reconcile(session)
      let changed = removed > 0 || reseated > 0
      for (const agent of room.agents) {
        try {
          changed = this.step(session, agent, now) || changed
        } catch (error) {
          agent.stats.errors += 1
          console.error(`RL agent ${agent.player.name} in ${code}:`, error)
        }
      }
      if (changed) this.broadcast?.schedule(session)
      if (room.agents.length === 0 || session.state.phase === 'ended') this.rooms.delete(code)
    }
  }

  /**
   * The market is about to close: every agent that has not made this year's abatement decision
   * makes it now, on the screen as it stands. The host decides when the market closes and the agent
   * cannot know it, so tying the decision to the agent's last trade (as `step` does) would skip it
   * whenever the market closes before the schedule's last slot (50 s). In training the abatement is
   * likewise the decision that comes after the window. Called right before `Session.closeTrade`.
   * True if any agent decided.
   */
  finishWindow(session: Session): boolean {
    const room = this.roomOf(session)
    if (!room || session.state.phase !== 'trade') return false
    const { currentYear: year, capMode } = session.state
    const stage = `${year}:trade`
    let decided = false
    for (const agent of room.agents) {
      if (!session.state.players.includes(agent.player) || capMode !== agent.mode) continue
      const own = agent.clock?.stage === stage ? agent.clock : null
      if (own?.done) continue
      agent.clock = { stage, startedAt: own?.startedAt ?? 0, count: own?.count ?? 0, done: true }
      try {
        this.decide(session, agent, 'abate')
        decided = true
      } catch (error) {
        agent.stats.errors += 1
        console.error(`RL agent ${agent.player.name} in ${session.state.roomCode}:`, error)
      }
    }
    return decided
  }

  private roomOf(session: Session): Room | undefined {
    const room = this.rooms.get(session.state.roomCode)
    return room && room.session === session ? room : undefined
  }

  /** The agent's own model when it fits the mode, otherwise the first runnable model that does. */
  private modelFor(mode: CapMode, homeModelId: string): LoadedModel | null {
    const home = this.source.getModel(homeModelId)
    if (home?.policy && home.info.mode === mode) return home
    for (const info of this.source.listModels()) {
      if (info.mode !== mode || info.error !== null) continue
      const model = this.source.getModel(info.id)
      if (model?.policy) return model
    }
    return null
  }

  private seat(agent: Agent, model: LoadedModel) {
    agent.mode = model.info.mode as RlMode
    agent.policy = model.policy as Policy
    agent.featureSet = model.featureSet
    agent.player.agentModel = model.info.id
  }

  private step(session: Session, agent: Agent, now: number): boolean {
    const { phase, currentYear: year, capMode } = session.state
    // A round under a mode no model was found for is sat out: the policy has never seen one.
    if (phase === 'lobby' || phase === 'ended' || capMode !== agent.mode) return false

    // The cap stage: one sealed bid, at the schedule's first slot.
    if (phase === 'cap') {
      if (!session.usesAuction || !this.due(agent, `${year}:cap`, now, 1)) return false
      this.decide(session, agent, 'bid')
      return true
    }

    // The market: up to a full schedule of buy/sell decisions, the abatement decision straight
    // after the last of them, then nothing until the market closes.
    if (phase === 'trade') {
      if (!this.due(agent, `${year}:trade`, now, this.offsets.length)) return false
      this.decide(session, agent, 'trade')
      if (agent.clock!.done) this.decide(session, agent, 'abate')
      return true
    }

    if (phase !== 'yearSummary') return false
    // The year-summary screen is where a student reads the round's results.
    if (agent.settledYear !== year) {
      agent.settledYear = year
      remember(agent.memory, playerSnapshot(session, agent.player.id))
    }
    // A referendum's vote, at the vote stage's first slot: by the shared rule, as the bots do —
    // no model has learnt to vote.
    const r = session.activeReferendum
    if (!r || r.stage !== 'vote' || !this.due(agent, `vote:${r.id}`, now, 1)) return false
    return session.castRuleVotes([agent.player.id])
  }

  /**
   * Whether the agent's next decision in `stage` is due, counting it if so. A stage it has not
   * seen before starts its clock at `now` (the first poll that sees it open, within POLL_MS). The
   * schedule is fixed from that start, so polling latency does not add up; after a stall the
   * missed decisions follow one per poll. At most `limit` decisions in a stage.
   */
  private due(agent: Agent, stage: string, now: number, limit: number): boolean {
    let clock = agent.clock
    if (!clock || clock.stage !== stage) {
      clock = { stage, startedAt: now, count: 0, done: false }
      agent.clock = clock
    }
    const n = Math.min(limit, this.offsets.length)
    if (clock.done || clock.count >= n || now < clock.startedAt + this.offsets[clock.count]) return false
    clock.count += 1
    if (clock.count >= n) clock.done = true
    return true
  }

  private decide(session: Session, agent: Agent, kind: StepKind) {
    const snap = playerSnapshot(session, agent.player.id)
    // Exactly as in training: fold this snapshot into memory, then observe it.
    remember(agent.memory, snap)
    const obs = observe(snap, agent.memory, agent.mode, kind, agent.featureSet)
    // A model trained before borrowing leaves it selected, as bots do; a later one chooses.
    const intent = decode(agent.policy.act(obs.vector), snap, kind, undefined, agent.featureSet >= 2 ? 'action' : 'always')
    const { rejected } = apply(session, agent.player.id, intent)
    if (rejected) agent.stats.refused += 1
    if (kind === 'bid') agent.stats.bids += 1
    else if (kind === 'trade') agent.stats.trades += 1
    else agent.stats.abatements += 1
  }
}

export const agents = new RlAgentManager()

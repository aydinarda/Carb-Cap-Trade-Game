import { INDUSTRY_NAMES, type Industry } from '../../shared/constants'
import type { CapMode, Player, RlModelInfo } from '../../shared/types'
import { GameError, type Session, type SessionStore } from '../session'
import { playerSnapshot } from '../views'
import { apply, decode } from './act'
import { createMemory, remember, type Memory } from './memory'
import { getModel, listModels, type LoadedModel, type Policy } from './models'
import { observe, type RlMode, type StepKind } from './observe'

/**
 * Plays the RL agents a host added in the lobby.
 *
 * An agent is an ordinary company (`addPlayer`, not `addBot`) because that is what it was trained
 * as: the leaderboard, the class counts and its own memory all see it as a student. It reads
 * exactly the `playerSnapshot` a student's screen receives and acts through the same Session
 * methods the socket handlers call, on the clock it was trained with: one sealed bid at the cap
 * stage, a buy/sell decision every `agent_every_seconds` once the market opens, and the abatement
 * decision straight after the last of them. A host who closes the market before then skips that
 * round's abatement decision, like a student who never reached the slider.
 *
 * A policy only understands the mode it was trained in, and the host can change the mode under
 * it (see `reconcile`): in the lobby the agent is removed; once the game has started the company
 * cannot leave, so another model trained for the new mode takes over, and the agent's own model
 * returns when the room does. With no model for the mode, the company sits the rounds out.
 *
 * Mirrors rl/live-agent.ts, which plays the same way over a socket from outside the server.
 */

/** How often the clock is checked; a decision lands within this of when it is due. */
const POLL_MS = 200
/** The bid waits this long after the cap stage opens, as the socket agent does. */
const BID_DELAY_MS = 500
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
  everyMs: number
  decisionsPerWindow: number
  memory: Memory
  capSeen: { year: number; at: number } | null
  bidYear: number | null
  window: { year: number; count: number; nextAt: number; done: boolean } | null
  settledYear: number | null
  stats: AgentStats
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

  constructor(private readonly source: ModelSource = DISK) {}

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
        capSeen: null,
        bidYear: null,
        window: null,
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
    agent.everyMs = model.everyMs
    agent.decisionsPerWindow = model.decisionsPerWindow
    agent.player.agentModel = model.info.id
  }

  private step(session: Session, agent: Agent, now: number): boolean {
    const { phase, currentYear: year, capMode } = session.state
    // A round under a mode no model was found for is sat out: the policy has never seen one.
    if (phase === 'lobby' || phase === 'ended' || capMode !== agent.mode) return false

    if (phase === 'cap') {
      if (!session.usesAuction || agent.bidYear === year) return false
      let seen = agent.capSeen
      if (!seen || seen.year !== year) {
        seen = { year, at: now }
        agent.capSeen = seen
      }
      if (now - seen.at < BID_DELAY_MS) return false
      agent.bidYear = year
      this.decide(session, agent, 'bid')
      return true
    }

    if (phase === 'trade') {
      let window = agent.window
      if (!window || window.year !== year) {
        window = { year, count: 0, nextAt: now + agent.everyMs, done: false }
        agent.window = window
      }
      if (window.done || now < window.nextAt) return false
      window.count += 1
      // A fixed cadence from the window's start, so polling latency does not add up over 15 decisions.
      window.nextAt += agent.everyMs
      this.decide(session, agent, 'trade')
      if (window.count >= agent.decisionsPerWindow) {
        window.done = true
        this.decide(session, agent, 'abate')
      }
      return true
    }

    // The year-summary screen is where a student reads the round's results.
    if (phase === 'yearSummary' && agent.settledYear !== year) {
      agent.settledYear = year
      remember(agent.memory, playerSnapshot(session, agent.player.id))
    }
    return false
  }

  private decide(session: Session, agent: Agent, kind: StepKind) {
    const snap = playerSnapshot(session, agent.player.id)
    // Exactly as in training: fold this snapshot into memory, then observe it.
    remember(agent.memory, snap)
    const obs = observe(snap, agent.memory, agent.mode, kind)
    const intent = decode(agent.policy.act(obs.vector), snap, kind)
    const { rejected } = apply(session, agent.player.id, intent)
    if (rejected) agent.stats.refused += 1
    if (kind === 'bid') agent.stats.bids += 1
    else if (kind === 'trade') agent.stats.trades += 1
    else agent.stats.abatements += 1
  }
}

export const agents = new RlAgentManager()

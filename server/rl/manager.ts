import { INDUSTRY_NAMES, type Industry } from '../../shared/constants'
import type { Player } from '../../shared/types'
import { GameError, type Session, type SessionStore } from '../session'
import { playerSnapshot } from '../views'
import { apply, decode } from './act'
import { createMemory, remember, type Memory } from './memory'
import { getModel, type Policy } from './models'
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

export class RlAgentManager {
  private rooms = new Map<string, { session: Session; agents: Agent[] }>()
  private timer?: NodeJS.Timeout
  private store?: SessionStore
  private broadcast?: AgentBroadcast

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
    const model = getModel(modelId)
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
      player.agentModel = info.id
      room.agents.push({
        player,
        mode: info.mode as RlMode,
        policy,
        everyMs: model.everyMs,
        decisionsPerWindow: model.decisionsPerWindow,
        memory: createMemory(),
        capSeen: null,
        bidYear: null,
        window: null,
        settledYear: null,
        stats: { bids: 0, trades: 0, abatements: 0, refused: 0, errors: 0 },
      })
      added.push(player)
    }
    return added
  }

  /** The agents still in a room, with what they have done. */
  statsFor(session: Session): { playerId: string; model: string | undefined; stats: AgentStats }[] {
    const room = this.rooms.get(session.state.roomCode)
    if (!room || room.session !== session) return []
    return room.agents
      .filter((a) => session.state.players.includes(a.player))
      .map((a) => ({ playerId: a.player.id, model: a.player.agentModel, stats: { ...a.stats } }))
  }

  /** One pass over every room with agents. Public so tests can drive the clock. */
  tick(now: number) {
    for (const [code, room] of this.rooms) {
      const { session } = room
      const swept = this.store !== undefined && this.store.get(code) !== session
      // A kicked agent is no longer in the player list; it stops playing with nothing to clean up.
      room.agents = room.agents.filter((a) => session.state.players.includes(a.player))
      if (swept || room.agents.length === 0) {
        this.rooms.delete(code)
        continue
      }
      let acted = false
      for (const agent of room.agents) {
        try {
          acted = this.step(session, agent, now) || acted
        } catch (error) {
          agent.stats.errors += 1
          console.error(`RL agent ${agent.player.name} in ${code}:`, error)
        }
      }
      if (acted) this.broadcast?.schedule(session)
      if (session.state.phase === 'ended') this.rooms.delete(code)
    }
  }

  private step(session: Session, agent: Agent, now: number): boolean {
    const { phase, currentYear: year, capMode } = session.state
    // A round under another regime is sat out: the policy has never seen one.
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

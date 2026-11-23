/**
 * When a live RL agent decides within a stage (2026-11-23).
 *
 * The host decides how long the cap stage, the market and a referendum's vote last, and the agent
 * cannot know it. So the agent decides on a front-loaded schedule from the moment it sees the
 * stage open: a quick start, then longer gaps. If the stage closes early the remaining decisions
 * are skipped; once they are all made the agent waits for the stage to end. Only RL agents use
 * it: bots keep the BotManager tick and students play as they like.
 *
 * The agents were trained on a fixed 2 s cadence over a 30 s window (`rl/world.ts`), with no
 * time in their observation, so they run unchanged on this schedule; only the market moves more
 * between their later decisions.
 */

/** `count` decisions, `everySeconds` apart. */
export interface ScheduleSegment {
  count: number
  everySeconds: number
}

/** The user's schedule: 5 decisions 2 s apart, then 5 at 3 s, then 5 at 5 s — all 15 by 50 s. */
export const RL_STAGE_SCHEDULE: readonly ScheduleSegment[] = [
  { count: 5, everySeconds: 2 },
  { count: 5, everySeconds: 3 },
  { count: 5, everySeconds: 5 },
]

/** The clock the agents had before (and were trained on): 15 decisions, 2 s apart. */
export const FIXED_2S_SCHEDULE: readonly ScheduleSegment[] = [{ count: 15, everySeconds: 2 }]

/**
 * When each decision is due, in ms from the stage's start: for RL_STAGE_SCHEDULE 2000, 4000, …,
 * 10000, 13000, …, 25000, 30000, …, 50000.
 */
export function decisionOffsets(schedule: readonly ScheduleSegment[]): number[] {
  const out: number[] = []
  let at = 0
  for (const { count, everySeconds } of schedule) {
    if (!(count >= 0 && Number.isInteger(count)) || !(everySeconds > 0)) {
      throw new Error(`bad schedule segment: ${count} decisions every ${everySeconds} s`)
    }
    for (let i = 0; i < count; i++) {
      at += everySeconds * 1000
      out.push(at)
    }
  }
  if (out.length === 0) throw new Error('a schedule needs at least one decision')
  return out
}

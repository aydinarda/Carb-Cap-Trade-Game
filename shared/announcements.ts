import type { PlayerSnapshot } from './types'

/**
 * Standing regulator announcements — what the class is TOLD about each event, as data.
 *
 * Lives in `shared/` rather than next to the panel that renders it because it is the single
 * definition of what a player knows about an event. The banner takes its text from here and
 * the RL agent (`rl/observe.ts`) takes its event features from here, so the two cannot drift:
 * an agent must not be told a magnitude the screen withholds, and the screen must not say
 * something the agent is never shown.
 *
 * `facts` carries the numbers the message states, and ONLY those — every value in it appears
 * literally in `title` or `detail`. That is what keeps the covert rate cut covert for the agent
 * too: its message states no number, so its `facts` is empty. `rl/__tests__/rl.spec.ts` pins it.
 */
export type AnnouncementKey = 'crisis' | 'rates' | 'subsidy' | 'tech'
export type AnnouncementState = 'pending' | 'active' | 'past'

export interface Announcement {
  key: AnnouncementKey
  state: AnnouncementState
  title: string
  detail: string
  facts: Record<string, number>
}

export const ANNOUNCEMENT_KEYS: AnnouncementKey[] = ['crisis', 'rates', 'subsidy', 'tech']
export const ANNOUNCEMENT_STATES: AnnouncementState[] = ['pending', 'active', 'past']

/**
 * Every fact a message of each kind can state, across all of its states. A fixed list so a
 * consumer that needs a fixed shape (the agent's observation vector) has one. Facts ending in
 * `_round` are absolute round numbers, exactly as the message prints them.
 */
export const ANNOUNCEMENT_FACTS: Record<AnnouncementKey, string[]> = {
  crisis: ['magnitude_pct', 'from_round', 'rounds_left', 'until_round'],
  rates: [],
  subsidy: ['discount_pct', 'from_round', 'rounds_to_start', 'rounds_left', 'until_round'],
  tech: ['cap_pct', 'from_round'],
}

export function announcements(snap: PlayerSnapshot): Announcement[] {
  const out: Announcement[] = []
  const year = snap.currentYear

  // First in the list, and deliberately so: it is the only announcement here that has ALREADY
  // moved a number the player is looking at. `plannedEmission` jumps the moment a crisis is
  // declared, so without this line the screen shows a company emitting more for no stated
  // reason — which reads as a bug rather than as an event. The other two describe options
  // that open later; this one explains what just happened.
  const c = snap.energyCrisis
  if (c) {
    const pct = Math.round(c.magnitude * 100)
    if (year < c.fromYear) {
      out.push({
        key: 'crisis',
        title: 'Energy crisis: oil and gas are short across Europe',
        detail: `Coal mines are reopening — expect emissions ${pct}% above trend from round ${c.fromYear}.`,
        state: 'pending',
        facts: { magnitude_pct: pct, from_round: c.fromYear },
      })
    } else if (year <= c.toYear) {
      const left = c.toYear - year + 1
      out.push({
        key: 'crisis',
        title: 'Energy crisis: oil and gas are short across Europe',
        detail: `Coal is back on the grid and your emissions are ${pct}% above trend. Expected to be resolved in ${left} round${left === 1 ? '' : 's'}, after round ${c.toYear}.`,
        state: 'active',
        facts: { magnitude_pct: pct, rounds_left: left, until_round: c.toYear },
      })
    } else {
      out.push({
        key: 'crisis',
        title: 'Energy crisis over — emissions back to trend',
        detail: `Gas supply is restored and the coal plants are off again. Ran rounds ${c.fromYear}–${c.toYear}.`,
        state: 'past',
        facts: {},
      })
    }
  }

  // The covert one. Flavour only, by design — no magnitude, no duration, and no mention that
  // it touched either emissions or the cost of a retrofit. Both of those show up on the
  // player's own numbers, and connecting them to this headline is the exercise. Resist the
  // urge to be helpful here: a detail line naming what it does turns the event into the
  // other two. Its `facts` stays empty for the same reason.
  const r = snap.rateCut
  if (r) {
    if (year < r.fromYear) {
      out.push({
        key: 'rates',
        title: 'FED cuts interest rates',
        detail: 'Global interest rates are expected to fall.',
        state: 'pending',
        facts: {},
      })
    } else if (year <= r.toYear) {
      out.push({
        key: 'rates',
        title: 'FED cuts interest rates',
        detail: 'Global interest rates are expected to fall.',
        state: 'active',
        facts: {},
      })
    } else {
      out.push({
        key: 'rates',
        title: 'Interest rates normalise',
        detail: 'The cutting cycle is over.',
        state: 'past',
        facts: {},
      })
    }
  }

  const s = snap.subsidy
  if (s) {
    const pct = Math.round(s.discount * 100)
    if (year < s.fromYear) {
      const away = s.fromYear - year
      out.push({
        key: 'subsidy',
        title: `${pct}% off retrofits from round ${s.fromYear}`,
        detail: `in ${away} round${away === 1 ? '' : 's'} · investing now costs full price, waiting delays the cut by a year`,
        state: 'pending',
        facts: { discount_pct: pct, from_round: s.fromYear, rounds_to_start: away },
      })
    } else if (year <= s.toYear) {
      const left = s.toYear - year + 1
      out.push({
        key: 'subsidy',
        title: `${pct}% off retrofits — live now`,
        detail: `${left} round${left === 1 ? '' : 's'} left, through round ${s.toYear}`,
        state: 'active',
        facts: { discount_pct: pct, rounds_left: left, until_round: s.toYear },
      })
    } else {
      out.push({
        key: 'subsidy',
        title: `${pct}% retrofit subsidy ended`,
        detail: `ran rounds ${s.fromYear}–${s.toYear}`,
        state: 'past',
        facts: { discount_pct: pct },
      })
    }
  }

  const t = snap.techUnlock
  if (t) {
    const pct = Math.round(t.lifetimeCap * 100)
    if (year < t.fromYear) {
      out.push({
        key: 'tech',
        title: `${t.label}: abatement budget rises to ${pct}%`,
        detail: `from round ${t.fromYear}`,
        state: 'pending',
        facts: { cap_pct: pct, from_round: t.fromYear },
      })
    } else {
      // Permanent, and therefore permanently ACTIVE. Greying it after the round it landed
      // in was a category error: the panel's grey means "no longer in force", and a company
      // still below the raised ceiling has a live option every single round. Recency
      // belongs in the wording, not in the colour.
      out.push({
        key: 'tech',
        title: `${t.label}: you may cut up to ${pct}%`,
        detail: year === t.fromYear ? 'in force from this round' : `in force since round ${t.fromYear}`,
        state: 'active',
        facts: { cap_pct: pct },
      })
    }
  }

  return out
}

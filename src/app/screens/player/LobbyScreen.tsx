import { Users } from 'lucide-react'
import type { PlayerSnapshot } from '@shared/types'
import { EmissionHistoryChart } from '../../components/game/charts'
import { IndustryBadge, RosterList } from '../../components/game/cards'
import { MODE_LABELS } from '../../components/game/theme'

export function LobbyScreen({ snap }: { snap: PlayerSnapshot }) {
  const mode = snap.capMode ? MODE_LABELS[snap.capMode] : null
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-border bg-card/70 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
          <div>
            <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">
              Your company
            </div>
            <div
              className="text-2xl font-black text-foreground"
              style={{ fontFamily: "'Unbounded', sans-serif" }}
            >
              {snap.you.id} · {snap.you.name}
            </div>
          </div>
          <IndustryBadge industry={snap.you.industry} />
        </div>
        {/* What the history is FOR, which is not the same in every mode.
            This used to say "Under grandfathering, this history determines your share of the
            free credits" to every class, whatever it was playing — wrong for three of the
            four modes, and the first thing a student reads. What is always true is that the
            history sets the emission the company starts from; whether it also sets the
            allocation is the mechanism's answer, not this file's. */}
        <p className="text-xs text-muted-foreground mb-4">
          Your emissions over the past ten years — they set what your company is expected to
          emit in Year {snap.currentYear}.{' '}
          {snap.freeAllocationBasis === 'history' &&
            'They also decide your share of the free credits: the more you have emitted, the more you are given.'}
          {snap.freeAllocationBasis === 'benchmark' &&
            'Your free credits do NOT come from it — they are set by your sector’s benchmark, the same for every company in the sector however much it has emitted.'}
          {snap.freeAllocationBasis === 'none' &&
            'There are no free credits in this mode: every allowance has to be bought.'}
        </p>
        <EmissionHistoryChart you={snap.you} />
      </div>

      {mode && (
        <div className="rounded-xl border border-border bg-card/70 p-4">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">
            Cap mechanism
          </div>
          <div className="text-sm font-bold text-foreground">{mode.label}</div>
          <p className="text-xs text-muted-foreground mt-1">{mode.desc}</p>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card/70 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
          <Users size={12} className="text-primary" />
          {snap.playerCount} compan{snap.playerCount === 1 ? 'y' : 'ies'} registered
        </div>
        <RosterList roster={snap.roster} youId={snap.you.id} />
      </div>

      <p className="text-center text-sm text-muted-foreground font-mono animate-pulse">
        Waiting for the instructor to start Year 11…
      </p>
    </div>
  )
}

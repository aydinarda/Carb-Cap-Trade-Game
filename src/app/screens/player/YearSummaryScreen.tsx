import { Flag, PartyPopper, Trophy } from 'lucide-react'
import type { PlayerSnapshot } from '@shared/types'
import { LeaderboardTable, SettlementCard, StatCard } from '../../components/game/cards'
import { ClassYearChart, EmissionHistoryChart } from '../../components/game/charts'

export function YearSummaryScreen({ snap }: { snap: PlayerSnapshot }) {
  const ended = snap.phase === 'ended'
  const agg = snap.classAggregate

  return (
    <div className="flex flex-col gap-5">
      {ended && (
        <div className="rounded-xl border border-primary/40 bg-primary/10 p-5 text-center">
          <div className="flex items-center justify-center gap-2 text-primary font-bold">
            <PartyPopper size={18} />
            Game over — thanks for playing!
          </div>
        </div>
      )}

      {snap.you.settlement && (
        <SettlementCard
          settlement={snap.you.settlement}
          penaltyPointsTotal={snap.you.penaltyPoints}
        />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Free credits" value={snap.you.freeAllocation ?? 0} unit="cr" />
        <StatCard
          label="From regulator"
          value={snap.you.regulatorGranted ?? 0}
          unit="cr"
          hint={
            snap.you.regulatorRequest !== null &&
            (snap.you.regulatorGranted ?? 0) < snap.you.regulatorRequest
              ? `requested ${snap.you.regulatorRequest} (pro-rated)`
              : undefined
          }
        />
        <StatCard label="Held at close" value={snap.you.creditsHeld ?? 0} unit="cr" />
        <StatCard label="Realized" value={snap.you.realized ?? 0} unit="tCO₂" tone="accent" />
      </div>

      {snap.leaderboard && (
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            <Trophy size={12} className="text-accent" />
            Leaderboard — fewest penalty points wins
          </div>
          <LeaderboardTable rows={snap.leaderboard} youId={snap.you.id} />
        </div>
      )}

      <div className="rounded-xl border border-border bg-card/70 p-5">
        <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
          Your emissions across all years
        </div>
        <EmissionHistoryChart you={snap.you} height={200} />
      </div>

      {agg && agg.yearHistory.length > 0 && (
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            <Flag size={12} className="text-primary" />
            Class emissions vs cap
          </div>
          <ClassYearChart aggregate={agg} height={200} />
        </div>
      )}

      {!ended && (
        <p className="text-center text-sm text-muted-foreground font-mono animate-pulse">
          Waiting for the instructor to start Year {snap.currentYear + 1}… (the cap
          mechanism may change)
        </p>
      )}
    </div>
  )
}

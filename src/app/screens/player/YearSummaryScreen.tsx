import { AlertTriangle, Flag, Landmark, PartyPopper, Trophy } from 'lucide-react'
import type { PlayerSnapshot } from '@shared/types'
import { LeaderboardTable, SettlementCard, StatCard } from '../../components/game/cards'
import { ClassYearChart, EmissionHistoryChart } from '../../components/game/charts'
import { cn } from '../../components/game/theme'

const r1 = (n: number) => Math.round(n * 10) / 10

export function YearSummaryScreen({ snap }: { snap: PlayerSnapshot }) {
  const ended = snap.phase === 'ended'
  const agg = snap.classAggregate
  // Carry after this year = held − realized = −netPosition. + banked, − make-good debt.
  const carry = snap.you.netPosition !== null ? r1(-snap.you.netPosition) : 0

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
        <SettlementCard settlement={snap.you.settlement} scoreTotal={snap.you.score} />
      )}

      {snap.you.settlement && carry !== 0 && (
        <div
          className={cn(
            'rounded-xl border p-3 flex items-center gap-2.5 text-sm font-mono',
            carry > 0
              ? 'border-primary/40 bg-primary/5 text-primary'
              : 'border-destructive/40 bg-destructive/5 text-destructive',
          )}
        >
          {carry > 0 ? (
            <>
              <Landmark size={15} className="shrink-0" />
              <span>
                <strong>Banked +{carry}</strong> credits.{' '}
                {ended
                  ? 'Cashed out at the final market price.'
                  : 'Carried into next year — already counts toward your holdings.'}
              </span>
            </>
          ) : (
            <>
              <AlertTriangle size={15} className="shrink-0" />
              <span>
                <strong>Make-good debt {carry}</strong>.{' '}
                {ended
                  ? 'Bought back at the final market price.'
                  : "Carried into next year on top of the penalty — cover it or you'll be fined again."}
              </span>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Free credits" value={snap.you.freeAllocation ?? 0} unit="cr" />
        <StatCard
          label="Net traded"
          value={
            snap.you.myTrades.reduce(
              (s, t) => s + (t.buyerId === snap.you.id ? t.qty : -t.qty),
              0,
            )
          }
          unit="cr"
          hint={snap.you.settlement ? `spent ${snap.you.settlement.purchaseCost}` : undefined}
        />
        <StatCard label="Held at close" value={snap.you.creditsHeld ?? 0} unit="cr" />
        <StatCard
          label="Realized"
          value={snap.you.realized ?? 0}
          unit="tCO₂"
          tone="accent"
          hint={
            snap.you.expectedEmission !== null
              ? `expected ${snap.you.expectedEmission}`
              : undefined
          }
        />
      </div>

      {snap.leaderboard && (
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            <Trophy size={12} className="text-accent" />
            Leaderboard — closest to your own optimum wins
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

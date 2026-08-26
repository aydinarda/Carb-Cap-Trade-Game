import { Ruler } from 'lucide-react'
import type { PlayerSnapshot } from '@shared/types'
import { FlowHint, StatCard } from '../../components/game/cards'
import { CAP_FLOW } from '../../components/game/theme'

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * Benchmarking cap stage. Nothing to submit — the allocation is already set by the
 * sector benchmark. The panel's job is to make the gap legible and point the player
 * at the two ways to close it: cut emissions, or buy on the secondary market.
 */
export function BenchmarkPanel({ snap }: { snap: PlayerSnapshot }) {
  const expected = snap.you.plannedEmission
  const allocation = snap.you.freeAllocation ?? 0
  const benchmark = snap.sectorBenchmark ?? allocation
  const average = snap.sectorAverage
  const gap = r1(allocation - expected) // < 0 short, > 0 surplus
  const short = gap < 0

  const agg = snap.classAggregate
  const classIssued = agg?.totalFreeAllocation ?? null
  const classExpected = agg?.totalExpected ?? null
  const classGapPct =
    classIssued !== null && classExpected !== null && classExpected > 0
      ? Math.round(((classIssued - classExpected) / classExpected) * 100)
      : null

  // How far below the sector average this benchmark sits — the stringency, restated
  // from the numbers actually in force rather than from the constant.
  const stringencyPct =
    average !== null && average > 0 ? Math.round((1 - benchmark / average) * 100) : null

  return (
    <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
          <Ruler size={12} className="text-accent" />
          Benchmark allocation — Year {snap.currentYear}
        </div>
        {/* The price signal carried into this round. */}
        {snap.prevMarketPrice !== null ? (
          <span className="text-xs font-mono text-primary border border-primary/30 rounded-full px-2 py-0.5">
            last round ≈ {r1(snap.prevMarketPrice)}
          </span>
        ) : (
          <span className="text-xs font-mono text-muted-foreground border border-border rounded-full px-2 py-0.5">
            first round — no price yet
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Sector benchmark"
          value={benchmark}
          unit="cr"
          tone="accent"
          hint={
            average !== null && stringencyPct !== null
              ? `${stringencyPct}% below the ${average.toLocaleString()} t sector average`
              : 'free credits per company'
          }
        />
        <StatCard label="Your allocation" value={allocation} unit="cr" hint="issued, free" />
        <StatCard
          label="Expected emission"
          value={expected}
          unit="t"
          hint="realized at year end"
        />
        <StatCard
          label="Projected gap"
          value={gap}
          unit="t"
          tone={short ? 'bad' : 'good'}
          hint={short ? 'short — must cover' : 'surplus — can sell'}
        />
      </div>

      {/* The four cards above already carry every number the old paragraph repeated — the
          benchmark, the stringency, the allocation, the expected emission and the gap. All
          that was genuinely extra is whether the CLASS is short or just this company, which
          is the difference between "I drew a bad hand" and "the cap binds", so it stays. */}
      <FlowHint steps={CAP_FLOW.benchmarking} />
      {classGapPct !== null && (
        <p className="text-[11px] font-mono text-muted-foreground">
          Class-wide: {classIssued?.toLocaleString()} cr issued against{' '}
          {classExpected?.toLocaleString()} t expected ({classGapPct > 0 ? '+' : ''}
          {classGapPct}%) — {classGapPct < 0 ? 'everyone is short, not just you' : 'the class is long overall'}.
        </p>
      )}
    </div>
  )
}

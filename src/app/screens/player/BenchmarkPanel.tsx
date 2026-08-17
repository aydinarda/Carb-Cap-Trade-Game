import { Ruler } from 'lucide-react'
import type { PlayerSnapshot } from '@shared/types'
import { StatCard, WarningBanner } from '../../components/game/cards'

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * Benchmarking cap stage. Nothing to submit — the allocation is already set by the
 * sector benchmark. The panel's job is to make the gap legible and point the player
 * at the two ways to close it: cut emissions, or buy on the secondary market.
 */
export function BenchmarkPanel({ snap }: { snap: PlayerSnapshot }) {
  const expected = snap.you.expectedEmission ?? 0
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

      <WarningBanner>
        Every company in your sector gets the same allocation, whatever its own history —
        the benchmark is set{' '}
        {stringencyPct !== null ? <strong>{stringencyPct}% below the sector average</strong> : 'below the sector average'}
        , so an average emitter is short and only an efficient one is long.{' '}
        {short ? (
          <>
            You are <strong>{Math.abs(gap)} tCO₂ short</strong>. Close the gap by cutting
            emissions or by buying on the market when it opens — anything left uncovered is
            charged the penalty.
          </>
        ) : (
          <>
            You are <strong>{gap} tCO₂ long</strong>. You can bank the surplus or sell it on
            the market when it opens.
          </>
        )}{' '}
        {classGapPct !== null && (
          <>
            Class-wide, {classIssued?.toLocaleString()} cr were issued against{' '}
            {classExpected?.toLocaleString()} t expected ({classGapPct}%).
          </>
        )}
      </WarningBanner>
    </div>
  )
}

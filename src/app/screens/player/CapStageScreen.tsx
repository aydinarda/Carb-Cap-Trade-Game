import type { PlayerSnapshot } from '@shared/types'
import { AllocationCard, FlowHint, StatCard } from '../../components/game/cards'
import { EmissionHistoryChart } from '../../components/game/charts'
import { CAP_FLOW } from '../../components/game/theme'
import { AuctionBidPanel } from './AuctionBidPanel'
import { BenchmarkPanel } from './BenchmarkPanel'

export function CapStageScreen({ snap }: { snap: PlayerSnapshot }) {
  const historyPanel = (
    <div className="rounded-xl border border-border bg-card/70 p-5">
      <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
        Your emission history
      </div>
      <EmissionHistoryChart you={snap.you} height={180} />
    </div>
  )

  // Auctioning: buy every allowance at a sealed-bid auction.
  if (snap.capMode === 'auctioning') {
    return (
      <div className="flex flex-col gap-5">
        <AuctionBidPanel snap={snap} />
        {historyPanel}
      </div>
    )
  }

  // Benchmarking: a flat sector allocation set below the sector average, so most
  // companies open short. Nothing to submit — the panel explains the gap and points
  // at the two ways to close it.
  if (snap.capMode === 'benchmarking') {
    return (
      <div className="flex flex-col gap-5">
        <BenchmarkPanel snap={snap} />
        {historyPanel}
      </div>
    )
  }

  // Grandfathering: free allocation only — nothing to buy at the cap stage.
  // Everything else is traded on the open market next.
  const freeAllocation = snap.you.freeAllocation ?? 0
  // The gap is the whole point of this screen, and it used to be buried in a paragraph.
  // As cards it matches how the other two modes' cap panels already present themselves.
  const planned = snap.you.plannedEmission
  const gap = Math.round((freeAllocation - planned) * 10) / 10
  const short = gap < 0
  return (
    <div className="flex flex-col gap-5">
      <AllocationCard freeAllocation={freeAllocation} mode={snap.capMode!} />
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label={`Year ${snap.currentYear} emissions`}
          value={planned}
          unit="tCO₂"
          tone="accent"
          hint="expected — actual is revealed at year end"
        />
        <StatCard
          label={short ? 'Short' : 'Covered'}
          value={Math.abs(gap)}
          unit="tCO₂"
          tone={short ? 'bad' : 'good'}
          hint={short ? 'cut emissions or buy on the market' : 'surplus — bank it or sell it'}
        />
      </div>
      <FlowHint steps={CAP_FLOW[snap.capMode!]} />
      {historyPanel}
    </div>
  )
}

import type { PlayerSnapshot } from '@shared/types'
import { AllocationCard, WarningBanner } from '../../components/game/cards'
import { EmissionHistoryChart } from '../../components/game/charts'
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
  return (
    <div className="flex flex-col gap-5">
      <AllocationCard freeAllocation={freeAllocation} mode={snap.capMode!} />
      <WarningBanner>
        These are the only credits issued to you — there is no fixed-price sale. Your expected
        Year {snap.currentYear} emission is <strong>{snap.you.plannedEmission} tCO₂</strong>{' '}
        (actual realized at year end). Cover any shortfall by trading on the market, or by cutting
        emissions, once the market opens.
      </WarningBanner>
      {historyPanel}
    </div>
  )
}

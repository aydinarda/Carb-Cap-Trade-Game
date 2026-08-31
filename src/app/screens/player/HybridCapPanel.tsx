import { Scale } from 'lucide-react'
import type { PlayerSnapshot } from '@shared/types'
import { StatCard } from '../../components/game/cards'
import { AuctionBidPanel } from './AuctionBidPanel'

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * Hybrid cap stage: the free allocation, then the auction for whatever it does not cover.
 *
 * Deliberately two panels rather than one. The allocation is settled before the player
 * arrives — there is nothing to decide about it — while the bid below is the only decision
 * on this screen, and `AuctionBidPanel` is reused unchanged so that decision looks and
 * behaves exactly as it does under pure auctioning.
 *
 * What this strip has to make legible is the SUBTRACTION the mode turns on: your sector's
 * benchmark, the share of it you were actually issued, and the residual you now have to buy.
 * A player whose sector share is 0 sees a zero here and the full emission to bid for, which
 * is the comparison the class argues about.
 */
export function HybridCapPanel({ snap }: { snap: PlayerSnapshot }) {
  const planned = snap.you.plannedEmission
  const free = snap.you.freeAllocation ?? 0
  const banked = snap.you.banked ?? 0
  const benchmark = snap.sectorBenchmark
  // What the auction (or the market after it) still has to supply.
  const residual = r1(Math.max(0, planned - free - banked))
  // The share this sector was granted, restated from the numbers in force rather than from
  // the config — the host can change it between years.
  const sharePct =
    benchmark !== null && benchmark > 0 ? Math.round((free / benchmark) * 100) : null

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-primary/30 bg-card/80 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
            <Scale size={12} className="text-primary" />
            Free allocation — Year {snap.currentYear}
          </div>
          <span className="text-xs font-mono text-muted-foreground border border-border rounded-full px-2 py-0.5">
            auction supply {snap.auctionSupply.toLocaleString()} cr
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="Sector benchmark"
            value={benchmark ?? 0}
            unit="cr"
            hint="the full figure for your sector"
          />
          <StatCard
            label="Issued to you free"
            value={free}
            unit="cr"
            tone={free > 0 ? 'good' : 'bad'}
            hint={
              sharePct !== null
                ? `${sharePct}% of the benchmark — your sector's share`
                : 'your sector receives no free credits'
            }
          />
          <StatCard
            label="Expected emission"
            value={planned}
            unit="t"
            hint="realized at year end"
          />
          <StatCard
            label="Left to buy"
            value={residual}
            unit="t"
            tone={residual > 0 ? 'accent' : 'good'}
            hint={residual > 0 ? 'bid for it below, or buy on the market' : 'already covered'}
          />
        </div>

        <p className="text-[11px] font-mono text-muted-foreground mt-3">
          {free > 0
            ? 'Every free credit issued this year was taken out of the auction supply above — the cap is fixed, so free allocation moves who pays, not how much is emitted.'
            : 'Your sector receives no free allocation, so the whole emission must be bought — at the auction below or on the market afterwards.'}
        </p>
      </div>

      <AuctionBidPanel snap={snap} />
    </div>
  )
}

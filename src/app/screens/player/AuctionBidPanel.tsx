import { Check, Gavel } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { PlayerSnapshot } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { FlowHint, StatCard } from '../../components/game/cards'
import { CAP_FLOW } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

const r1 = (n: number) => Math.round(n * 10) / 10

/** Auctioning cap stage: submit a sealed bid (quantity + max price). */
export function AuctionBidPanel({ snap }: { snap: PlayerSnapshot }) {
  const { submitBid } = useGame()
  const expected = snap.you.plannedEmission
  const committed = snap.you.auctionBid
  const cleared = snap.auctionPrice !== null

  const priceAnchor = snap.prevMarketPrice ?? 10
  const [qty, setQty] = useState<number>(committed?.qty ?? Math.round(expected))
  const [price, setPrice] = useState<number>(committed?.price ?? r1(priceAnchor))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setQty(snap.you.auctionBid?.qty ?? Math.round(snap.you.plannedEmission))
    setPrice(snap.you.auctionBid?.price ?? r1(snap.prevMarketPrice ?? 10))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.currentYear])

  const submit = async () => {
    setBusy(true)
    const ok = await submitBid(qty, price)
    setBusy(false)
    if (ok) toast.success(`Bid submitted: ${qty} credits at up to ${price} each`)
  }

  // After the auction clears, show the outcome.
  if (cleared) {
    const award = snap.you.auctionAward ?? 0
    const clearing = snap.auctionPrice ?? 0
    return (
      <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-4">
          <Gavel size={12} className="text-accent" />
          Auction result — Year {snap.currentYear}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard label="Clearing price" value={clearing} tone="accent" hint="everyone pays this" />
          <StatCard label="You won" value={award} unit="cr" tone={award > 0 ? 'good' : 'bad'} />
          <StatCard label="Cost" value={r1(award * clearing)} tone="bad" hint={`${award} × ${clearing}`} />
        </div>
        {committed && (
          <p className="text-[11px] text-muted-foreground font-mono mt-3">
            Your bid was {committed.qty} cr at up to {committed.price}.{' '}
            {committed.price >= clearing
              ? 'Won at the clearing price.'
              : 'Bid below clearing — not filled.'}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
          <Gavel size={12} className="text-accent" />
          Auction — sealed bid, Year {snap.currentYear}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* What this company has to cover — it is what the quantity field defaults to, so
              without it on screen the default is a number out of nowhere. */}
          <span className="text-xs font-mono text-muted-foreground border border-border rounded-full px-2 py-0.5">
            you need ≈ {expected.toLocaleString()} t
          </span>
          {snap.prevMarketPrice !== null && (
            <span className="text-xs font-mono text-primary border border-primary/30 rounded-full px-2 py-0.5">
              last round ≈ {r1(snap.prevMarketPrice)}
            </span>
          )}
          <span className="text-xs font-mono text-accent border border-accent/30 rounded-full px-2 py-0.5">
            supply {snap.auctionSupply.toLocaleString()} cr
          </span>
        </div>
      </div>

      <FlowHint steps={CAP_FLOW.auctioning} />

      <div className="grid grid-cols-2 gap-4 mt-5">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono uppercase text-muted-foreground">Quantity (cr)</label>
          <Input
            type="number"
            min={0}
            step="0.1"
            value={qty}
            onChange={(e) => setQty(Math.max(0, Number(e.target.value)))}
            className="font-mono text-right"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono uppercase text-muted-foreground">Max price / credit</label>
          <Input
            type="number"
            min={0}
            step="0.1"
            value={price}
            onChange={(e) => setPrice(Math.max(0, Number(e.target.value)))}
            className="font-mono text-right"
          />
        </div>
      </div>

      <div className="flex items-center justify-between mt-5">
        <span className="text-xs font-mono text-muted-foreground">
          If fully won: up to {r1(qty * price).toLocaleString()} cost
        </span>
        <Button onClick={() => void submit()} disabled={busy} className="font-bold">
          {committed ? (
            <>
              <Check size={14} /> Update bid
            </>
          ) : (
            'Submit bid'
          )}
        </Button>
      </div>
      {committed && (
        <p className="text-xs text-primary font-mono mt-2 flex items-center gap-1">
          <Check size={12} /> Bid in — changeable until the instructor closes the auction.
        </p>
      )}
    </div>
  )
}

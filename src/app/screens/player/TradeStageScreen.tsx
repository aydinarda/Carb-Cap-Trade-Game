import { ArrowRightLeft, Check, ShoppingCart } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { PlayerSnapshot } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Slider } from '../../components/ui/slider'
import { StatCard, WarningBanner } from '../../components/game/cards'
import { useGame } from '../../net/GameContext'

export function TradeStageScreen({ snap }: { snap: PlayerSnapshot }) {
  const { buyCredits } = useGame()
  const price = snap.regulatorPrice
  const realized = snap.you.realized ?? 0
  const alreadyBought = snap.you.secondaryBought ?? 0
  // creditsHeld already includes alreadyBought; the pre-top-up holding is
  // held − alreadyBought, so the shortfall to cover is realized − that.
  const held = snap.you.creditsHeld ?? 0
  const baseHeld = Math.round((held - alreadyBought) * 10) / 10
  const shortfall = Math.max(0, Math.round((realized - baseHeld) * 10) / 10)

  // Local input = the desired TOTAL bought this year (server treats it as a set).
  const [qty, setQty] = useState<number>(alreadyBought || shortfall)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setQty(snap.you.secondaryBought ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.currentYear])

  const projectedHeld = Math.round((baseHeld + qty) * 10) / 10
  const projectedGap = Math.round((realized - projectedHeld) * 10) / 10
  const stillShort = projectedGap > 0
  const cost = Math.round(qty * price * 10) / 10
  const sliderMax = Math.max(20, Math.ceil(shortfall * 1.5))

  const submit = async () => {
    setBusy(true)
    const ok = await buyCredits(qty)
    setBusy(false)
    if (ok) toast.success(`Buying ${qty} credits @ ${price} — cost ${cost}`)
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Realized emissions" value={realized} unit="tCO₂" tone="accent" />
        <StatCard
          label="Credits before buying"
          value={baseHeld}
          unit="cr"
          hint="free + regulator (cap stage)"
        />
        <StatCard
          label={stillShort ? 'Still short' : 'Covered'}
          value={stillShort ? projectedGap : Math.abs(projectedGap)}
          unit="tCO₂"
          tone={stillShort ? 'bad' : 'good'}
          hint={stillShort ? 'buy more to avoid the penalty' : 'no penalty at settlement'}
          icon={<ArrowRightLeft size={12} />}
        />
      </div>

      {/* Fixed-price buy panel */}
      <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
            <ShoppingCart size={12} className="text-accent" />
            Buy credits from the regulator
          </div>
          <span className="text-xs font-mono text-accent border border-accent/30 rounded-full px-2 py-0.5">
            fixed price {price} / credit
          </span>
        </div>

        <WarningBanner>
          The price is a real cost. Every credit you buy costs {price}; each tCO₂ left
          uncovered costs the penalty rate at settlement. Surplus credits expire — don&apos;t
          overbuy. Lowest total cost wins.
        </WarningBanner>

        <div className="flex items-center gap-4 mt-5">
          <Slider
            value={[Math.min(qty, sliderMax)]}
            onValueChange={([v]) => setQty(v)}
            max={sliderMax}
            step={1}
            className="flex-1"
          />
          <Input
            type="number"
            min={0}
            step="0.1"
            value={qty}
            onChange={(e) => setQty(Math.max(0, Number(e.target.value)))}
            className="w-28 font-mono text-right"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 mt-5">
          <StatCard label="Credits after buying" value={projectedHeld} unit="cr" />
          <StatCard
            label="Cost of this purchase"
            value={cost}
            tone="bad"
            hint={`${qty} × ${price}`}
          />
        </div>

        <div className="flex items-center justify-between mt-5">
          <span className="text-xs font-mono text-muted-foreground">
            {shortfall > 0
              ? `Buy ${shortfall} to exactly cover your emissions`
              : 'You are already covered — buying is optional'}
          </span>
          <Button onClick={() => void submit()} disabled={busy} className="font-bold">
            {alreadyBought > 0 ? (
              <>
                <Check size={14} /> Update purchase
              </>
            ) : (
              'Confirm purchase'
            )}
          </Button>
        </div>
        {alreadyBought > 0 && (
          <p className="text-xs text-primary font-mono mt-2 flex items-center gap-1">
            <Check size={12} /> Buying {alreadyBought} credits — you can change it until the
            instructor closes the market.
          </p>
        )}
      </div>
    </div>
  )
}

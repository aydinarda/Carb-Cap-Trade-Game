import { ArrowRightLeft, Check, ShoppingCart, Tag } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { PlayerSnapshot } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Slider } from '../../components/ui/slider'
import { StatCard, WarningBanner } from '../../components/game/cards'
import { cn } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

type Side = 'buy' | 'sell'

export function TradeStageScreen({ snap }: { snap: PlayerSnapshot }) {
  const { buyCredits, sellCredits } = useGame()
  const buyPrice = snap.regulatorPrice
  const sellPrice = snap.sellPrice
  // Players trade against their EXPECTED (mean) emission — the actual is realized
  // only at year end, so buying/selling to the mean is a bet, not a certainty.
  const expected = snap.you.expectedEmission ?? 0
  const base =
    (snap.you.freeAllocation ?? 0) + (snap.you.regulatorGranted ?? 0) // free + regulator, pre-secondary
  const committedBought = snap.you.secondaryBought ?? 0
  const committedSold = snap.you.secondarySold ?? 0

  const [side, setSide] = useState<Side>(expected > base ? 'buy' : 'sell')
  const [buyQty, setBuyQty] = useState(committedBought)
  const [sellQty, setSellQty] = useState(committedSold)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setBuyQty(snap.you.secondaryBought ?? 0)
    setSellQty(snap.you.secondarySold ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.currentYear])

  const effBought = side === 'buy' ? buyQty : committedBought
  const effSold = side === 'sell' ? sellQty : committedSold
  const held = Math.round((base + effBought - effSold) * 10) / 10
  const gap = Math.round((expected - held) * 10) / 10
  const short = gap > 0

  const sellMax = Math.round((base + committedBought) * 10) / 10 // can't sell what you don't hold
  const buyCost = Math.round(buyQty * buyPrice * 10) / 10
  const sellIncome = Math.round(sellQty * sellPrice * 10) / 10
  const sliderMax =
    side === 'buy' ? Math.max(20, Math.ceil(Math.max(0, expected - base) * 1.5)) : Math.max(1, sellMax)

  const submit = async () => {
    setBusy(true)
    const ok =
      side === 'buy' ? await buyCredits(buyQty) : await sellCredits(sellQty)
    setBusy(false)
    if (ok)
      toast.success(
        side === 'buy'
          ? `Buying ${buyQty} @ ${buyPrice} — cost ${buyCost}`
          : `Selling ${sellQty} @ ${sellPrice} — income ${sellIncome}`,
      )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Expected emissions"
          value={expected}
          unit="tCO₂"
          tone="accent"
          hint="mean — actual is realized at year end"
        />
        <StatCard label="Credits held (after)" value={held} unit="cr" hint="free + regulator ± trades" />
        <StatCard
          label={short ? 'Short vs expected' : 'Covers expected'}
          value={Math.abs(gap)}
          unit="tCO₂"
          tone={short ? 'bad' : 'good'}
          hint={short ? 'buy more to cover the mean' : 'selling more risks a shortage'}
          icon={<ArrowRightLeft size={12} />}
        />
      </div>

      <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
        {/* Buy / Sell toggle */}
        <div className="flex items-center justify-between gap-2 mb-4">
          <div className="flex rounded-lg border border-border overflow-hidden">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={cn(
                  'px-5 py-2 text-sm font-bold transition-colors',
                  side === s
                    ? s === 'buy'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-accent text-accent-foreground'
                    : 'bg-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {s === 'buy' ? 'Buy' : 'Sell'}
              </button>
            ))}
          </div>
          <span className="text-xs font-mono text-accent border border-accent/30 rounded-full px-2 py-0.5 flex items-center gap-1">
            {side === 'buy' ? <ShoppingCart size={11} /> : <Tag size={11} />}
            {side === 'buy' ? `buy ${buyPrice}` : `sell ${sellPrice}`} / credit
          </span>
        </div>

        <WarningBanner>
          You only know your <strong>expected</strong> emission ({expected}); the actual is
          realized at year end and may differ. Buying costs {buyPrice}/credit, selling earns{' '}
          {sellPrice}/credit, and each tCO₂ left uncovered costs the penalty rate. Surplus
          credits expire. Lowest total cost wins.
        </WarningBanner>

        {side === 'buy' ? (
          <>
            <div className="flex items-center gap-4 mt-5">
              <Slider
                value={[Math.min(buyQty, sliderMax)]}
                onValueChange={([v]) => setBuyQty(v)}
                max={sliderMax}
                step={1}
                className="flex-1"
              />
              <Input
                type="number"
                min={0}
                step="0.1"
                value={buyQty}
                onChange={(e) => setBuyQty(Math.max(0, Number(e.target.value)))}
                className="w-28 font-mono text-right"
              />
            </div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <StatCard label="Total buying" value={buyQty} unit="cr" />
              <StatCard label="Cost" value={buyCost} tone="bad" hint={`${buyQty} × ${buyPrice}`} />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-4 mt-5">
              <Slider
                value={[Math.min(sellQty, sliderMax)]}
                onValueChange={([v]) => setSellQty(Math.min(v, sellMax))}
                max={sliderMax}
                step={1}
                className="flex-1"
              />
              <Input
                type="number"
                min={0}
                max={sellMax}
                step="0.1"
                value={sellQty}
                onChange={(e) => setSellQty(Math.min(sellMax, Math.max(0, Number(e.target.value))))}
                className="w-28 font-mono text-right"
              />
            </div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <StatCard label="Total selling" value={sellQty} unit="cr" hint={`max ${sellMax}`} />
              <StatCard
                label="Income"
                value={sellIncome}
                tone="good"
                hint={`${sellQty} × ${sellPrice}`}
              />
            </div>
          </>
        )}

        <div className="flex items-center justify-end mt-5">
          <Button onClick={() => void submit()} disabled={busy} className="font-bold">
            {side === 'buy'
              ? committedBought > 0
                ? 'Update purchase'
                : 'Confirm purchase'
              : committedSold > 0
                ? 'Update sale'
                : 'Confirm sale'}
          </Button>
        </div>
        {(committedBought > 0 || committedSold > 0) && (
          <p className="text-xs text-primary font-mono mt-2 flex items-center gap-1">
            <Check size={12} /> Committed: buying {committedBought}, selling {committedSold} — you
            can change until the market closes.
          </p>
        )}
      </div>
    </div>
  )
}

import { ArrowRightLeft, Check, Leaf, ShoppingCart, Tag } from 'lucide-react'
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
const r1 = (n: number) => Math.round(n * 10) / 10

export function TradeStageScreen({ snap }: { snap: PlayerSnapshot }) {
  const { buyCredits, sellCredits, abate } = useGame()
  const buyPrice = snap.regulatorPrice
  const sellPrice = snap.sellPrice
  const { a, b } = snap.abatementCoeff
  // Raw (pre-abatement) expected mean. Players face this uncertainty; the actual
  // is realized only at year end. Three levers: cut emissions, buy, or sell.
  const rawExpected = snap.you.expectedEmission ?? 0
  const base = (snap.you.freeAllocation ?? 0) + (snap.you.regulatorGranted ?? 0)
  const committedBought = snap.you.secondaryBought ?? 0
  const committedSold = snap.you.secondarySold ?? 0
  const committedAbate = snap.you.abatement ?? 0

  const [side, setSide] = useState<Side>('buy')
  const [abateFrac, setAbateFrac] = useState(committedAbate)
  const [buyQty, setBuyQty] = useState(committedBought)
  const [sellQty, setSellQty] = useState(committedSold)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setAbateFrac(snap.you.abatement ?? 0)
    setBuyQty(snap.you.secondaryBought ?? 0)
    setSellQty(snap.you.secondarySold ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.currentYear])

  // Emissions after the chosen cuts (live preview) — buy/sell target this.
  const postExpected = r1(rawExpected * (1 - abateFrac))
  const abateCost = r1(rawExpected * (a * abateFrac + (b * abateFrac * abateFrac) / 2))
  const marginalCost = r1(a + b * abateFrac) // MAC at the current cut level

  const effBought = side === 'buy' ? buyQty : committedBought
  const effSold = side === 'sell' ? sellQty : committedSold
  const held = r1(base + effBought - effSold)
  const gap = r1(postExpected - held)
  const short = gap > 0

  const sellMax = r1(base + committedBought)
  const buyCost = r1(buyQty * buyPrice)
  const sellIncome = r1(sellQty * sellPrice)
  const tradeSliderMax =
    side === 'buy' ? Math.max(20, Math.ceil(Math.max(0, postExpected - base) * 1.5)) : Math.max(1, sellMax)

  const submitTrade = async () => {
    setBusy(true)
    const ok = side === 'buy' ? await buyCredits(buyQty) : await sellCredits(sellQty)
    setBusy(false)
    if (ok)
      toast.success(
        side === 'buy'
          ? `Buying ${buyQty} @ ${buyPrice} — cost ${buyCost}`
          : `Selling ${sellQty} @ ${sellPrice} — income ${sellIncome}`,
      )
  }

  const submitAbate = async () => {
    setBusy(true)
    const ok = await abate(abateFrac)
    setBusy(false)
    if (ok) toast.success(`Cutting ${Math.round(abateFrac * 100)}% — cost ${abateCost}`)
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Expected (raw)" value={rawExpected} unit="tCO₂" hint="before cuts" />
        <StatCard
          label="After your cuts"
          value={postExpected}
          unit="tCO₂"
          tone="accent"
          hint="realized around this at year end"
        />
        <StatCard label="Credits held" value={held} unit="cr" hint="free + reg ± trades" />
        <StatCard
          label={short ? 'Short' : 'Covered'}
          value={Math.abs(gap)}
          unit="tCO₂"
          tone={short ? 'bad' : 'good'}
          icon={<ArrowRightLeft size={12} />}
        />
      </div>

      <WarningBanner>
        You only know your <strong>expected</strong> emission; the actual is realized at year
        end. Three moves: <strong>cut</strong> emissions (rising cost), <strong>buy</strong> at{' '}
        {buyPrice}, or leave a shortage (penalty). Cut while it&apos;s cheaper than buying.
      </WarningBanner>

      {/* Abatement */}
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
        <div className="flex items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
            <Leaf size={12} className="text-primary" />
            Cut emissions (invest in abatement)
          </div>
          <span
            className={cn(
              'text-xs font-mono border rounded-full px-2 py-0.5',
              marginalCost <= buyPrice
                ? 'text-primary border-primary/30'
                : 'text-destructive border-destructive/30',
            )}
          >
            next-tonne cost {marginalCost} vs price {buyPrice}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <Slider
            value={[Math.round(abateFrac * 100)]}
            onValueChange={([v]) => setAbateFrac(v / 100)}
            max={100}
            step={1}
            className="flex-1"
          />
          <div className="w-16 font-mono text-right text-lg font-bold">{Math.round(abateFrac * 100)}%</div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-5">
          <StatCard label="Cut" value={r1(rawExpected - postExpected)} unit="tCO₂" tone="good" />
          <StatCard label="Abatement cost" value={abateCost} tone="bad" />
        </div>
        <div className="flex items-center justify-between mt-4">
          <span className="text-[11px] text-muted-foreground font-mono">
            Keep cutting while the next-tonne cost is below the carbon price.
          </span>
          <Button onClick={() => void submitAbate()} disabled={busy} variant="outline" className="font-bold">
            {committedAbate > 0 ? 'Update cuts' : 'Invest in cuts'}
          </Button>
        </div>
      </div>

      {/* Buy / Sell */}
      <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
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

        {side === 'buy' ? (
          <>
            <div className="flex items-center gap-4 mt-1">
              <Slider
                value={[Math.min(buyQty, tradeSliderMax)]}
                onValueChange={([v]) => setBuyQty(v)}
                max={tradeSliderMax}
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
            <div className="flex items-center gap-4 mt-1">
              <Slider
                value={[Math.min(sellQty, tradeSliderMax)]}
                onValueChange={([v]) => setSellQty(Math.min(v, sellMax))}
                max={tradeSliderMax}
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
              <StatCard label="Income" value={sellIncome} tone="good" hint={`${sellQty} × ${sellPrice}`} />
            </div>
          </>
        )}

        <div className="flex items-center justify-end mt-5">
          <Button onClick={() => void submitTrade()} disabled={busy} className="font-bold">
            {side === 'buy'
              ? committedBought > 0
                ? 'Update purchase'
                : 'Confirm purchase'
              : committedSold > 0
                ? 'Update sale'
                : 'Confirm sale'}
          </Button>
        </div>
        {(committedBought > 0 || committedSold > 0 || committedAbate > 0) && (
          <p className="text-xs text-primary font-mono mt-2 flex items-center gap-1">
            <Check size={12} /> Committed: cut {Math.round(committedAbate * 100)}%, buy{' '}
            {committedBought}, sell {committedSold} — changeable until the market closes.
          </p>
        )}
      </div>
    </div>
  )
}

import { ArrowRightLeft, BookOpen, History, Leaf, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { OrderSide, PlayerSnapshot } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Slider } from '../../components/ui/slider'
import { StatCard, WarningBanner } from '../../components/game/cards'
import { MarketTicker, OrderBook, TradesFeed } from '../../components/game/market'
import { cn } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

const r1 = (n: number) => Math.round(n * 10) / 10

export function TradeStageScreen({ snap }: { snap: PlayerSnapshot }) {
  const { placeOrder, cancelOrder, abate } = useGame()
  const { a, b } = snap.abatementCoeff
  const market = snap.market
  const marketPrice = market?.lastPrice ?? market?.vwap ?? null

  const rawExpected = snap.you.expectedEmission ?? 0
  const held = snap.you.creditsHeld ?? 0
  const committedAbate = snap.you.abatement ?? 0

  const [abateFrac, setAbateFrac] = useState(committedAbate)
  const [side, setSide] = useState<OrderSide>('buy')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setAbateFrac(snap.you.abatement ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.currentYear])

  const postExpected = r1(rawExpected * (1 - abateFrac))
  const abateCost = r1(rawExpected * (a * abateFrac + (b * abateFrac * abateFrac) / 2))
  const marginalCost = r1(a + b * abateFrac)
  const gap = r1(postExpected - held) // > 0 short, < 0 surplus
  const short = gap > 0

  const submitOrder = async () => {
    setBusy(true)
    const ok = await placeOrder(side, Number(qty), Number(price))
    setBusy(false)
    if (ok) {
      toast.success(`${side === 'buy' ? 'Bid' : 'Ask'} placed: ${qty} cr @ ${price}`)
      setQty('')
      setPrice('')
    }
  }

  const submitAbate = async () => {
    setBusy(true)
    const ok = await abate(abateFrac)
    setBusy(false)
    if (ok) toast.success(`Cutting ${Math.round(abateFrac * 100)}% — cost ${abateCost}`)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-5">
      {/* Main column */}
      <div className="flex flex-col gap-5">
        {market && <MarketTicker market={market} />}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Expected (after cuts)" value={postExpected} unit="tCO₂" tone="accent" />
          <StatCard label="Credits held" value={held} unit="cr" hint="free/auction ± trades" />
          <StatCard
            label={short ? 'Short' : 'Covered'}
            value={Math.abs(gap)}
            unit="tCO₂"
            tone={short ? 'bad' : 'good'}
            icon={<ArrowRightLeft size={12} />}
          />
          <StatCard label="Market price" value={marketPrice ?? '—'} hint="last / vwap" />
        </div>

        <WarningBanner>
          No fixed price — you trade with other companies. Place limit <strong>bids</strong> (buy)
          and <strong>asks</strong> (sell); orders match by best price. You can only sell credits
          you hold (no shorting). The price emerges from the class. Uncovered tCO₂ pays the penalty.
        </WarningBanner>

        {/* Abatement */}
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
              <Leaf size={12} className="text-primary" />
              Cut emissions (abatement)
            </div>
            <span
              className={cn(
                'text-xs font-mono border rounded-full px-2 py-0.5',
                marketPrice !== null && marginalCost <= marketPrice
                  ? 'text-primary border-primary/30'
                  : 'text-muted-foreground border-border',
              )}
            >
              next-tonne cost {marginalCost} vs market {marketPrice ?? '—'}
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
            <div className="w-14 font-mono text-right text-lg font-bold">
              {Math.round(abateFrac * 100)}%
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <StatCard label="Cut" value={r1(rawExpected - postExpected)} unit="tCO₂" tone="good" />
            <StatCard label="Abatement cost" value={abateCost} tone="bad" />
          </div>
          <div className="flex justify-end mt-3">
            <Button onClick={() => void submitAbate()} disabled={busy} variant="outline" className="font-bold">
              {committedAbate > 0 ? 'Update cuts' : 'Invest in cuts'}
            </Button>
          </div>
        </div>

        {/* Order entry */}
        <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-4">
            <Send size={12} className="text-accent" />
            Place a limit order — you set the price
          </div>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submitOrder()
            }}
          >
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
                  {s === 'buy' ? 'Bid (buy)' : 'Ask (sell)'}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono uppercase text-muted-foreground">Quantity</label>
              <Input
                type="number"
                min={0.1}
                step="0.1"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="w-28 font-mono"
                placeholder="20"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono uppercase text-muted-foreground">Price</label>
              <Input
                type="number"
                min={0.1}
                step="0.1"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-28 font-mono"
                placeholder={marketPrice?.toString() ?? '10'}
              />
            </div>
            <Button
              type="submit"
              disabled={busy || !qty || !price || Number(qty) <= 0 || Number(price) <= 0}
              className="font-bold"
            >
              Place order
            </Button>
          </form>
          {side === 'sell' && (
            <p className="text-[11px] text-muted-foreground font-mono mt-2">
              You can offer up to what you hold minus your open asks — no shorting.
            </p>
          )}
        </div>

        {/* Order book */}
        {market && (
          <div className="rounded-xl border border-border bg-card/70 p-5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
              <BookOpen size={12} className="text-primary" />
              Order book — your orders highlighted (others anonymised)
            </div>
            <OrderBook market={market} youId={snap.you.id} onCancel={(id) => void cancelOrder(id)} />
          </div>
        )}
      </div>

      {/* Right: live trades feed (chat-like) */}
      <div className="rounded-xl border border-border bg-card/70 p-4 lg:sticky lg:top-3 h-fit">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
          <History size={12} className="text-primary" />
          Live trades
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {market && <TradesFeed trades={market.trades} youId={snap.you.id} max={40} />}
        </div>
      </div>
    </div>
  )
}

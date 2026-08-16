import { AlertTriangle, ArrowRightLeft, BookOpen, Gavel, History, Landmark, Leaf, Send } from 'lucide-react'
import { motion } from 'motion/react'
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
  const auctionPrice = snap.auctionPrice

  const rawExpected = snap.you.expectedEmission ?? 0
  const held = snap.you.creditsHeld ?? 0
  const committedAbate = snap.you.abatement ?? 0
  const banked = snap.you.banked ?? 0

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
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
      {/* Left: decisions */}
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Expected (after cuts)" value={postExpected} unit="tCO₂" tone="accent" />
          <StatCard label="Credits held" value={held} unit="cr" hint="free/auction/banked ± trades" />
          <StatCard
            label={short ? 'Short' : 'Covered'}
            value={Math.abs(gap)}
            unit="tCO₂"
            tone={short ? 'bad' : 'good'}
            icon={<ArrowRightLeft size={12} />}
          />
          <StatCard label="Market price" value={marketPrice ?? '—'} hint="last / vwap" />
        </div>

        {banked !== 0 && (
          <div
            className={cn(
              'rounded-xl border p-3 flex items-center gap-2.5 text-sm font-mono',
              banked > 0
                ? 'border-primary/40 bg-primary/5 text-primary'
                : 'border-destructive/40 bg-destructive/5 text-destructive',
            )}
          >
            {banked > 0 ? (
              <>
                <Landmark size={15} className="shrink-0" />
                <span>
                  <strong>Banked +{r1(banked)}</strong> credits carried from last year — already in
                  your holdings.
                </span>
              </>
            ) : (
              <>
                <AlertTriangle size={15} className="shrink-0" />
                <span>
                  <strong>Make-good debt {r1(banked)}</strong> carried from last year — you must
                  cover it on top of this year&apos;s emissions, or pay the penalty again.
                </span>
              </>
            )}
          </div>
        )}

        <WarningBanner>
          No fixed price — you trade with other companies. Place limit <strong>bids</strong> (buy)
          and <strong>asks</strong> (sell); orders match by best price, no shorting. Uncovered tCO₂
          pays the <strong>penalty</strong> — and still carries forward as a make-good debt. Surplus
          credits are <strong>banked</strong> for next year (cashed out at game end).
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
                placeholder={(auctionPrice ?? marketPrice)?.toString() ?? '10'}
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
      </div>

      {/* Right: live market — auction signal, order book, trades feed */}
      <div className="flex flex-col gap-4 lg:sticky lg:top-3 h-fit">
        {auctionPrice !== null && (
          <motion.div
            className="rounded-xl border border-accent/60 bg-accent/10 p-4 text-center"
            animate={{ boxShadow: ['0 0 0 0 rgba(245,166,35,0.5)', '0 0 0 10px rgba(245,166,35,0)'] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
          >
            <div className="flex items-center justify-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              <Gavel size={11} className="text-accent" />
              Auction cleared at
            </div>
            <div className="text-4xl font-black font-mono text-accent leading-none mt-1">
              {auctionPrice}
            </div>
            <div className="text-[10px] text-muted-foreground font-mono mt-1">
              reference price / credit — anchor your bids &amp; asks around this
            </div>
          </motion.div>
        )}

        {market && <MarketTicker market={market} />}

        {market && (
          <div className="rounded-xl border border-border bg-card/70 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
              <BookOpen size={12} className="text-primary" />
              Order book — yours highlighted
            </div>
            <OrderBook market={market} youId={snap.you.id} onCancel={(id) => void cancelOrder(id)} />
          </div>
        )}

        {market && (
          <div className="rounded-xl border border-border bg-card/70 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
              <History size={12} className="text-primary" />
              Live trades
            </div>
            <div className="max-h-[40vh] overflow-y-auto">
              <TradesFeed trades={market.trades} youId={snap.you.id} max={40} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
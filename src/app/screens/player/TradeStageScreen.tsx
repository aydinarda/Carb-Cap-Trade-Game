import { AlertTriangle, ArrowRightLeft, BookOpen, Gavel, History, Landmark, Leaf, Send } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { abatementCost, marginalCost } from '@shared/engine/abatement'
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
  const abatementSpec = snap.abatement
  // A plant cannot switch itself off, and this is a budget for the WHOLE game, not per
  // year. The server clamps to this too — the fallback covers a client running ahead of a
  // backend that does not send the field yet.
  const maxAbate = snap.abatementLifetimeCap ?? 1
  const market = snap.market
  const marketPrice = market?.lastPrice ?? market?.vwap ?? null
  const auctionPrice = snap.auctionPrice

  // What this year actually has to be covered. Fixed for the year: capacity bought today
  // arrives next year, so nothing the slider does can move it.
  const planned = snap.you.plannedEmission ?? 0
  // The base every fraction on this screen is a fraction of — emissions stripped of the
  // cuts already installed.
  const unabated = snap.you.unabatedExpected ?? planned
  const held = snap.you.creditsHeld ?? 0
  const inForce = snap.you.abatementInForce ?? 0
  const installed = snap.you.abatementCommitted ?? 0
  const fixedCost = snap.you.abatementFixedCost ?? 0
  const banked = snap.you.banked ?? 0

  const [abateFrac, setAbateFrac] = useState(installed)
  const [side, setSide] = useState<OrderSide>('buy')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)

  // Keyed on the installed level, NOT on the year. Wiping the slider every year was right
  // when the choice was annual; under a permanent one it would show 0% to a company that
  // has already built and paid for half its capacity.
  useEffect(() => {
    setAbateFrac(installed)
  }, [installed])

  // Evaluated with the very functions the server settles with, so the preview cannot
  // drift from the charge — and so a scenario on a non-linear MAC curve previews correctly.
  // Only the NEW slice is charged, and the retrofit fee is charged again for this step.
  const stepping = abateFrac > installed
  const variableCost = r1(
    abatementCost(unabated, abateFrac, abatementSpec) -
      abatementCost(unabated, installed, abatementSpec),
  )
  const abateCost = stepping ? r1(fixedCost + variableCost) : 0
  const nextTonneCost = r1(marginalCost(abateFrac, abatementSpec))
  // What this year's emissions would be once the pending capacity comes online.
  const nextYearEmission = r1(unabated * (1 - abateFrac))
  const gap = r1(planned - held) // > 0 short, < 0 surplus
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
    if (ok) {
      toast.success(
        `Installed ${Math.round(abateFrac * 100)}% capacity for ${abateCost} — live from next round`,
      )
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
      {/* Left: decisions */}
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* Must NOT move with the slider. Under the one-year lag that would be the most
              damaging lie on the screen: it would show a player covered when they are not. */}
          <StatCard
            label="This year's emissions"
            value={planned}
            unit="tCO₂"
            tone="accent"
            hint={inForce > 0 ? `${Math.round(inForce * 100)}% already cut` : 'fixed for this year'}
          />
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
              Install abatement capacity
              {/* Say why the slider stops, or it reads as a bug — and say that the budget is
                  for the whole game, since that is what makes spending it a decision. */}
              <span className="normal-case tracking-normal text-[10px] text-muted-foreground/70">
                — up to {Math.round(maxAbate * 100)}% of your emissions, permanently
                {installed > 0 && ` · ${Math.round(installed * 100)}% already installed`}
              </span>
            </div>
            <span
              className={cn(
                'text-xs font-mono border rounded-full px-2 py-0.5',
                marketPrice !== null && nextTonneCost <= marketPrice
                  ? 'text-primary border-primary/30'
                  : 'text-muted-foreground border-border',
              )}
            >
              next-tonne cost {nextTonneCost} vs market {marketPrice ?? '—'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            {/* The floor is what is already installed: a retrofit cannot be taken back, and
                the widget should say so rather than letting the server reject the move. */}
            <Slider
              value={[Math.round(abateFrac * 100)]}
              onValueChange={([v]) =>
                setAbateFrac(Math.min(Math.max(v / 100, installed), maxAbate))
              }
              min={Math.round(installed * 100)}
              max={Math.round(maxAbate * 100)}
              step={1}
              className="flex-1"
            />
            <div className="w-14 font-mono text-right text-lg font-bold">
              {Math.round(abateFrac * 100)}%
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <StatCard
              label="From next year"
              value={nextYearEmission}
              unit="tCO₂"
              tone="good"
              hint={`instead of ${planned}`}
            />
            <StatCard
              label="Cost now"
              value={abateCost}
              tone="bad"
              // The fee is broken out because it is the thing you pay AGAIN if you step.
              hint={stepping ? `${fixedCost} retrofit fee + ${variableCost} for the extra ${Math.round((abateFrac - installed) * 100)}%` : 'move the slider up to install'}
            />
          </div>
          <div className="flex items-center justify-between gap-3 mt-3">
            {/* Unconditional. The game cannot know which year is the last one — the host
                ends it whenever — so a final-year install is simply wasted, and the only
                honest thing to do is say the delay out loud every time. */}
            <span className="text-[11px] font-mono text-accent">
              Takes effect from next round — this year&apos;s emissions are already set.
            </span>
            <Button
              onClick={() => void submitAbate()}
              disabled={busy || !stepping}
              variant="outline"
              className="font-bold shrink-0"
            >
              {installed > 0 ? 'Install more' : 'Install capacity'}
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

        {snap.prevMarketPrice !== null && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-2 flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Last round settled at
            </span>
            <span className="text-lg font-black font-mono text-primary">
              {r1(snap.prevMarketPrice)}
            </span>
          </div>
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
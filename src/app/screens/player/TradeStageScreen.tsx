import {
  AlertTriangle,
  BookOpen,
  Gavel,
  History,
  Landmark,
  Leaf,
  LineChart,
  Send,
  TrendingUp,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { abatementCost, marginalCost } from '@shared/engine/abatement'
import type { OrderSide, PlayerSnapshot } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Slider } from '../../components/ui/slider'
import { ComplianceStrip, Sparkline, StatCard } from '../../components/game/cards'
import { EmissionHistoryChart } from '../../components/game/charts'
import { OrderBook, PriceStrip, TradesFeed } from '../../components/game/market'
import { cn, PALETTE } from '../../components/game/theme'
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
  const penaltyRate = snap.penaltyRate

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
  // Tonnes the pending step would actually remove, per year, from next year on.
  const cutAmount = r1(unabated * (abateFrac - inForce))
  const gap = r1(planned - held) // > 0 short, < 0 surplus
  const short = gap > 0

  // --- the compliance decision, priced ------------------------------------------
  // Three costs for the same shortfall, so the comparison is on the screen rather than in
  // the student's head. `coverByAbating` is deliberately NOT presented as a way to settle
  // THIS year — capacity arrives next year — and ComplianceStrip labels it as such.
  const buyCost = short && marketPrice !== null ? r1(gap * marketPrice) : null
  const penaltyCost = short ? r1(gap * penaltyRate) : 0
  // The level that would cut `gap` tonnes a year off the un-abated base. Above the lifetime
  // cap there is no such level, and saying so beats quoting a price for an illegal move.
  const fracToCloseGap = unabated > 0 ? installed + gap / unabated : Infinity
  const abateEnough = short && fracToCloseGap <= maxAbate
  const coverByAbating = abateEnough
    ? r1(
        fixedCost +
          abatementCost(unabated, fracToCloseGap, abatementSpec) -
          abatementCost(unabated, installed, abatementSpec),
      )
    : null
  const abateBlockedReason = short && !abateEnough
    ? `not enough headroom — capped at ${Math.round(maxAbate * 100)}%`
    : undefined

  // The market's recent prints, oldest first — the sparkline beside the price.
  const priceSeries = (market?.trades ?? []).map((t) => t.price).slice(-24)
  const prevPrice = snap.prevMarketPrice
  const priceChange =
    marketPrice !== null && prevPrice !== null && prevPrice > 0
      ? Math.round(((marketPrice - prevPrice) / prevPrice) * 1000) / 10
      : null

  // The ticket's derived values. `orderValue` doubles as the submit guard: null means the
  // form is not yet a valid order, so the button label and its disabled state cannot
  // disagree about whether there is something to place.
  const qtyNum = Number(qty)
  const priceNum = Number(price)
  const orderValue = qty && price && qtyNum > 0 && priceNum > 0 ? r1(qtyNum * priceNum) : null
  // What is still offerable after the asks already resting. The engine enforces this; the
  // ticket only reports it, so a rejected order is never a surprise.
  const openAsks = (market?.asks ?? [])
    .filter((o) => o.playerId === snap.you.id)
    .reduce((s, o) => s + o.remaining, 0)
  const sellRoom = r1(Math.max(0, held - openAsks))

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
    <div className="flex flex-col gap-4">
      {/* --- the four numbers the whole decision turns on ------------------------ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label={short ? 'Shortage / gap to cover' : 'Covered — surplus'}
          value={Math.abs(gap)}
          unit="tCO₂"
          tone={short ? 'bad' : 'good'}
          // The one heading in the row that is an alarm, so it is the one that carries a
          // colour. Muted while the company is covered — there is nothing to raise then.
          labelTone={short ? 'bad' : undefined}
          emphasis
          icon={short ? <AlertTriangle size={12} /> : <Leaf size={12} />}
          hint={
            short
              ? `cover or pay ${penaltyRate}/t — the tonne is still owed after the fine`
              : 'banks into next year'
          }
        />
        <StatCard
          label="Market price"
          value={marketPrice ?? '—'}
          unit={marketPrice !== null ? 'per tCO₂' : undefined}
          tone="market"
          emphasis
          icon={<TrendingUp size={12} />}
          aside={<Sparkline points={priceSeries} color={PALETTE.market} />}
          hint={
            market?.vwap != null
              ? `VWAP ${r1(market.vwap)}${priceChange !== null ? ` · ${priceChange > 0 ? '+' : ''}${priceChange}% vs last year` : ''}`
              : 'nothing traded yet'
          }
        />
        <StatCard
          label="Next-tonne abatement cost"
          value={nextTonneCost}
          unit="per tCO₂"
          tone="good"
          emphasis
          icon={<Leaf size={12} />}
          hint={
            marketPrice === null
              ? 'no market price to compare with yet'
              : nextTonneCost <= marketPrice
                ? `cheaper than the market by ${r1(marketPrice - nextTonneCost)}`
                : `dearer than the market by ${r1(nextTonneCost - marketPrice)}`
          }
          hintTone={
            marketPrice !== null ? (nextTonneCost <= marketPrice ? 'good' : 'accent') : undefined
          }
        />
        {/* A NEGATIVE holding is not a holding — it is last year's make-good debt showing
            through, and printing it in the neutral colour beside the word "held" says a
            company owns something when it owes it. Under auctioning, where nobody starts
            with free credits, this is the normal opening state for anyone who skipped the
            auction, so it is not an edge case. */}
        <StatCard
          label={held < 0 ? 'Credits owed' : 'Credits held'}
          value={Math.abs(held)}
          unit="cr"
          tone={held < 0 ? 'bad' : 'default'}
          emphasis
          icon={<Landmark size={12} />}
          hint={
            held < 0
              ? 'carried debt — buy this back before you can cover anything'
              : 'free / auction / banked ± trades'
          }
        />
      </div>

      {/* --- buy, cut, or pay: the same shortfall priced three ways -------------- */}
      <ComplianceStrip
        gap={gap}
        buyCost={buyCost}
        penaltyCost={penaltyCost}
        penaltyRate={penaltyRate}
        abateCost={coverByAbating}
        abateBlockedReason={abateBlockedReason}
      />

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

      {auctionPrice !== null && (
        <motion.div
          className="rounded-xl border border-accent/60 bg-accent/10 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2"
          animate={{ boxShadow: ['0 0 0 0 rgba(255,179,26,0.45)', '0 0 0 10px rgba(255,179,26,0)'] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
        >
          <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            <Gavel size={11} className="text-accent" />
            Auction cleared at — anchor your bids and asks around this
          </span>
          <span className="text-2xl font-black font-mono text-accent leading-none">
            {auctionPrice}
          </span>
        </motion.div>
      )}

      {/* --- the three actions, side by side ------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* Cut emissions */}
        <section className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex flex-col gap-3">
          <header className="flex items-baseline justify-between gap-2">
            <h2 className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
              <Leaf size={12} className="text-primary" />
              Cut emissions (abatement)
            </h2>
            {/* The ceiling is a LIFETIME budget, not a per-year allowance — capacity is
                permanent, so what is spent is spent. Saying "per year" here would describe a
                model the engine stopped using: `setAbatement` clamps to this one number for
                the whole game. Read live from the snapshot so a host who changes it is
                never contradicted by the label. */}
            <span className="text-[10px] font-mono text-muted-foreground/80 text-right">
              max {Math.round(maxAbate * 100)}% · whole game
              {installed > 0 && (
                <>
                  <br />
                  {Math.round(installed * 100)}% installed ·{' '}
                  {Math.round((maxAbate - installed) * 100)}% left
                </>
              )}
            </span>
          </header>

          <div className="flex items-center gap-3">
            {/* The floor is what is already installed: a retrofit cannot be taken back, and
                the widget should say so rather than letting the server reject the move. */}
            <Slider
              value={[Math.round(abateFrac * 100)]}
              onValueChange={([v]) => setAbateFrac(Math.min(Math.max(v / 100, installed), maxAbate))}
              min={Math.round(installed * 100)}
              max={Math.round(maxAbate * 100)}
              step={1}
              className="flex-1"
            />
            <div className="w-12 font-mono text-right text-xl font-bold">
              {Math.round(abateFrac * 100)}%
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="Cut amount" value={cutAmount} unit="tCO₂" />
            <MiniStat label="Next-tonne cost" value={nextTonneCost} unit="per t" />
            <MiniStat
              label="Total cost est."
              value={abateCost}
              unit="cr"
              tone={stepping ? 'good' : 'muted'}
            />
          </div>

          <p className="text-[11px] font-mono text-muted-foreground">
            {stepping ? (
              <>
                {fixedCost} retrofit fee + {variableCost} for the extra{' '}
                {Math.round((abateFrac - installed) * 100)}% · emissions{' '}
                {r1(unabated * (1 - inForce))} → {nextYearEmission} tCO₂
              </>
            ) : (
              'move the slider up to install capacity'
            )}
          </p>

          {/* Unconditional. The game cannot know which year is the last one — the host ends
              it whenever — so a final-year install is simply wasted, and the only honest
              thing to do is say the delay out loud every time. */}
          <div className="flex items-center justify-between gap-2 mt-auto pt-1">
            <span className="text-[11px] font-mono text-accent">
              Live from next round — this year is already set.
            </span>
            <Button
              onClick={() => void submitAbate()}
              disabled={busy || !stepping}
              variant="outline"
              className="font-bold shrink-0"
            >
              Invest in cuts
            </Button>
          </div>
        </section>

        {/* Order ticket */}
        <section className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
          <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h2 className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
              <Send size={12} className="text-market" />
              Place limit order
            </h2>
            {market && (
              <PriceStrip
                market={market}
                auctionPrice={auctionPrice}
                prevPrice={snap.prevMarketPrice}
                onPick={(p) => setPrice(String(p))}
              />
            )}
          </header>

          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submitOrder()
            }}
          >
            {/* Buy is cyan and sell is amber, the same two hues the order book uses for bids
                and asks — the side you pick and the side of the book you are joining must
                never be different colours. */}
            <div className="grid grid-cols-2 rounded-lg border border-border overflow-hidden">
              {(['buy', 'sell'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={cn(
                    'py-2 text-sm font-bold transition-colors',
                    side === s
                      ? s === 'buy'
                        ? 'bg-market text-market-foreground'
                        : 'bg-accent text-accent-foreground'
                      : 'bg-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {s === 'buy' ? 'Buy (bid)' : 'Sell (ask)'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Price"
                unit="per tCO₂"
                value={price}
                onChange={setPrice}
                placeholder={(auctionPrice ?? marketPrice)?.toString() ?? '10'}
              />
              <Field
                label="Quantity"
                unit="cr"
                value={qty}
                onChange={setQty}
                placeholder="20"
                // Buying: the gap is the quantity that makes you exactly compliant.
                // Selling: everything not already promised to a resting ask.
                maxAction={{
                  label: 'Max',
                  onClick: () => setQty(String(side === 'buy' ? Math.max(0, gap) : sellRoom)),
                }}
              />
            </div>

            {/* What the order is actually worth. Every exchange ticket shows it, and here it
                is also the point: the student sees the cash consequence before committing. */}
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Est. total
              </span>
              <span className="font-mono text-lg font-bold">
                {orderValue !== null ? `${orderValue.toLocaleString()} cr` : '—'}
              </span>
            </div>
            {side === 'sell' && (
              <span className="text-[11px] font-mono text-muted-foreground/70 -mt-2">
                no shorting — max {sellRoom} cr
              </span>
            )}

            <Button
              type="submit"
              disabled={orderValue === null || busy}
              className={cn(
                'w-full font-bold',
                side === 'buy'
                  ? 'bg-market text-market-foreground hover:bg-market/90'
                  : 'bg-accent text-accent-foreground hover:bg-accent/90',
              )}
            >
              {orderValue === null
                ? `Place ${side} order`
                : `${side === 'buy' ? 'Buy' : 'Sell'} ${qty} cr @ ${price}`}
            </Button>
          </form>
        </section>

        {/* Order book */}
        <section className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
            <BookOpen size={12} className="text-market" />
            Order book — yours highlighted
          </h2>
          {market ? (
            <OrderBook
              market={market}
              youId={snap.you.id}
              onCancel={(id) => void cancelOrder(id)}
              onPickPrice={(p) => setPrice(String(p))}
            />
          ) : (
            <p className="text-xs text-muted-foreground font-mono">market not open</p>
          )}
        </section>
      </div>

      {/* --- history and the live tape ------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 items-start">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
            <LineChart size={12} className="text-primary" />
            Your emissions history
          </h2>
          <EmissionHistoryChart you={snap.you} />
        </section>

        {market && (
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
              <History size={12} className="text-market" />
              Live trades
            </h2>
            <div className="max-h-[38vh] overflow-y-auto">
              <TradesFeed trades={market.trades} youId={snap.you.id} max={40} />
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/** A compact figure inside a card — the abatement panel's three-up readout. */
function MiniStat({
  label,
  value,
  unit,
  tone = 'default',
}: {
  label: string
  value: number
  unit: string
  tone?: 'default' | 'good' | 'muted'
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-alt/60 px-2.5 py-2 flex flex-col gap-0.5 min-w-0">
      <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </span>
      <span
        className={cn(
          'font-mono font-bold text-base leading-none truncate',
          tone === 'good' && 'text-primary',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value.toLocaleString()}
        <span className="text-[10px] text-muted-foreground ml-1 font-normal">{unit}</span>
      </span>
    </div>
  )
}

/**
 * One numeric field of the ticket.
 *
 * Native spinners are suppressed: they sit exactly where the unit suffix goes and overlap it
 * on focus, and nudging a price 0.1 at a time with arrows is not how anyone fills a ticket.
 */
function Field({
  label,
  unit,
  value,
  onChange,
  placeholder,
  maxAction,
}: {
  label: string
  unit: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  maxAction?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label className="text-[10px] font-mono uppercase text-muted-foreground">
        {label} <span className="text-muted-foreground/60">({unit})</span>
      </label>
      <div className="relative flex">
        <Input
          type="number"
          min={0.1}
          step="0.1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'w-full font-mono [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            maxAction && 'pr-14',
          )}
          placeholder={placeholder}
        />
        {maxAction && (
          <button
            type="button"
            onClick={maxAction.onClick}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground hover:bg-surface-alt transition-colors"
          >
            {maxAction.label}
          </button>
        )}
      </div>
    </div>
  )
}

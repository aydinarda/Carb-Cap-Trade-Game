import { ArrowRightLeft, BookOpen, History, Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { OrderSide, PlayerSnapshot } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { StatCard } from '../../components/game/cards'
import { MarketTicker, OrderBook, TradesFeed } from '../../components/game/market'
import { cn } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

export function TradeStageScreen({ snap }: { snap: PlayerSnapshot }) {
  const { placeOrder, cancelOrder } = useGame()
  const [side, setSide] = useState<OrderSide>('buy')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)

  const realized = snap.you.realized ?? 0
  const held = snap.you.creditsHeld ?? 0
  const gap = Math.round((realized - held) * 10) / 10
  const shortage = gap > 0
  const market = snap.market

  const submit = async () => {
    setBusy(true)
    const ok = await placeOrder(side, Number(qty), Number(price))
    setBusy(false)
    if (ok) {
      toast.success(`${side === 'buy' ? 'Buy' : 'Sell'} order placed: ${qty} cr @ ${price}`)
      setQty('')
      setPrice('')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {market && <MarketTicker market={market} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatCard
          label="Your position"
          value={`${shortage ? '−' : '+'}${Math.abs(gap).toLocaleString()}`}
          unit="tCO₂"
          tone={shortage ? 'bad' : 'good'}
          hint={
            shortage
              ? `short — buy credits or face the penalty`
              : `surplus — sell it or it expires at year end`
          }
          icon={<ArrowRightLeft size={12} />}
        />
        <StatCard
          label="Credits held / realized"
          value={`${held.toLocaleString()} / ${realized.toLocaleString()}`}
          hint="free + regulator + net trades"
        />
      </div>

      {/* Order form */}
      <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-4">
          <Send size={12} className="text-accent" />
          Place a limit order — you set the price
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
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
                {s === 'buy' ? 'Buy' : 'Sell'}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-mono uppercase text-muted-foreground">Quantity (cr)</label>
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
            <label className="text-[10px] font-mono uppercase text-muted-foreground">Limit price</label>
            <Input
              type="number"
              min={0.1}
              step="0.1"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-28 font-mono"
              placeholder={market?.lastPrice?.toString() ?? '10'}
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
            You can offer up to what you hold minus your open offers.
          </p>
        )}
      </div>

      {/* Order book */}
      {market && (
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            <BookOpen size={12} className="text-primary" />
            Order book — your orders are highlighted
          </div>
          <OrderBook
            market={market}
            youId={snap.you.id}
            onCancel={(id) => void cancelOrder(id)}
          />
        </div>
      )}

      {/* Recent trades */}
      {market && (
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            <History size={12} className="text-primary" />
            Trades
          </div>
          <TradesFeed trades={market.trades} youId={snap.you.id} />
        </div>
      )}
    </div>
  )
}

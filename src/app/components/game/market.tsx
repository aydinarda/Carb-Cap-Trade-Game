import { RESERVE_ID } from '@shared/constants'
import { Activity, X } from 'lucide-react'
import type { MarketView, Order, Trade } from '@shared/types'
import { cn } from './theme'

export function MarketTicker({ market }: { market: MarketView }) {
  const stat = (label: string, value: string) => (
    <div className="flex flex-col items-center px-4">
      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-mono font-bold text-foreground">{value}</span>
    </div>
  )
  return (
    <div className="rounded-xl border border-accent/30 bg-card/80 py-2.5 flex items-center justify-center divide-x divide-border flex-wrap">
      <div className="flex items-center gap-1.5 px-4 text-accent">
        <Activity size={14} />
        <span className="text-xs font-mono uppercase tracking-wider">Market</span>
      </div>
      {stat('Last', market.lastPrice?.toString() ?? '—')}
      {stat('Best bid', market.bestBid?.toString() ?? '—')}
      {stat('Best ask', market.bestAsk?.toString() ?? '—')}
      {stat('VWAP', market.vwap?.toString() ?? '—')}
      {stat('Volume', market.volume.toLocaleString())}
    </div>
  )
}

/**
 * The same numbers as `MarketTicker`, compressed to one line and made clickable, for the
 * order ticket's header.
 *
 * It exists because the reference price and the field you type a price into were at
 * opposite ends of a long screen: you had to scroll away from the ticket to see what the
 * market was doing, then scroll back. Every price here fills the ticket's price field, so
 * the number does not have to be retyped or remembered at all.
 *
 * `prevPrice` is the fallback for `Last`. At the start of a round nothing has traded yet,
 * so last / bid / ask / vwap are all blank and the only anchor in the game is what last
 * round settled at — the strip relabels itself rather than showing a row of dashes.
 *
 * Volume is deliberately NOT clickable: it is the one figure here that is not a price, and
 * loading it into a price field would be nonsense.
 */
export function PriceStrip({
  market,
  auctionPrice,
  prevPrice,
  onPick,
}: {
  market: MarketView
  auctionPrice?: number | null
  prevPrice?: number | null
  onPick: (price: number) => void
}) {
  const usePrev = market.lastPrice === null && prevPrice != null
  const cells: { label: string; value: number | null; accent?: boolean }[] = [
    ...(auctionPrice != null ? [{ label: 'Auction', value: auctionPrice, accent: true }] : []),
    { label: usePrev ? 'Prev round' : 'Last', value: usePrev ? prevPrice! : market.lastPrice },
    { label: 'Bid', value: market.bestBid },
    { label: 'Ask', value: market.bestAsk },
    { label: 'VWAP', value: market.vwap },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono">
      {cells.map((c) => (
        <button
          key={c.label}
          type="button"
          disabled={c.value === null}
          onClick={() => c.value !== null && onPick(c.value)}
          title={c.value !== null ? 'Use this price' : undefined}
          className={cn(
            'rounded px-1.5 py-0.5 border transition-colors',
            c.value === null
              ? 'border-transparent text-muted-foreground/40'
              : c.accent
                ? 'border-accent/40 text-accent hover:bg-accent/10'
                : 'border-border text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
          )}
        >
          {c.label} <span className="font-bold">{c.value ?? '—'}</span>
        </button>
      ))}
      <span className="px-1 text-muted-foreground/60">
        Vol <span className="font-bold">{market.volume.toLocaleString()}</span>
      </span>
    </div>
  )
}

function OrderRow({
  order,
  mine,
  anonymous,
  onCancel,
  onPickPrice,
}: {
  order: Order
  mine: boolean
  anonymous: boolean
  onCancel?: (id: string) => void
  onPickPrice?: (price: number) => void
}) {
  // Anonymised for players (only your own orders are labelled); host sees ids. The cost
  // containment reserve is never anonymised — the whole point of resting its ladder in the
  // book is that the class can SEE where the regulator is willing to sell.
  const isReserve = order.playerId === RESERVE_ID
  const label = isReserve ? 'REGULATOR' : mine ? 'you' : anonymous ? '•' : order.playerId
  return (
    <div
      className={cn(
        'flex items-center justify-between text-xs font-mono py-1 px-2 rounded',
        mine && 'bg-primary/10 border border-primary/30',
        isReserve && 'bg-accent/10 border border-accent/40',
      )}
    >
      <span className={cn('font-bold w-9', mine ? 'text-primary' : 'text-muted-foreground')}>
        {label}
      </span>
      {/* The price is a button wherever the screen has an order form to fill — clicking a
          resting order to load its price is standard in a real book, and it saves a student
          retyping a number that is already on screen. Elsewhere (the host view) it stays
          plain text, so nothing implies an interaction that does not exist. */}
      {onPickPrice ? (
        <button
          type="button"
          onClick={() => onPickPrice(order.price)}
          title="Use this price in your order"
          className="text-foreground rounded px-1 -mx-1 hover:bg-foreground/10 transition-colors"
        >
          {order.remaining.toLocaleString()} <span className="text-muted-foreground">cr @</span>{' '}
          <span className={order.side === 'buy' ? 'text-primary' : 'text-accent'}>{order.price}</span>
        </button>
      ) : (
        <span className="text-foreground">
          {order.remaining.toLocaleString()} <span className="text-muted-foreground">cr @</span>{' '}
          <span className={order.side === 'buy' ? 'text-primary' : 'text-accent'}>{order.price}</span>
        </span>
      )}
      {mine && onCancel ? (
        <button
          onClick={() => onCancel(order.id)}
          className="text-muted-foreground hover:text-destructive transition-colors"
          title="Cancel order"
        >
          <X size={12} />
        </button>
      ) : (
        <span className="w-3" />
      )}
    </div>
  )
}

export function OrderBook({
  market,
  youId,
  anonymous = true,
  onCancel,
  onPickPrice,
}: {
  market: MarketView
  youId?: string
  /** Hide other players' ids (default true; host passes false). */
  anonymous?: boolean
  onCancel?: (id: string) => void
  /** Clicking a resting order loads its price into the caller's order form. Omit on any
   *  screen with no form — the rows then render as plain, non-interactive text. */
  onPickPrice?: (price: number) => void
}) {
  const column = (title: string, orders: Order[], empty: string) => (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5 text-center">
        {title}
      </div>
      <div className="flex flex-col gap-1">
        {orders.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 font-mono text-center py-3">{empty}</p>
        ) : (
          orders
            .slice(0, 12)
            .map((o) => (
              <OrderRow
                key={o.id}
                order={o}
                mine={o.playerId === youId}
                anonymous={anonymous}
                onCancel={onCancel}
                onPickPrice={onPickPrice}
              />
            ))
        )}
      </div>
    </div>
  )
  return (
    <div className="flex gap-4">
      {column('Buy orders (bids)', market.bids, 'no bids yet')}
      <div className="w-px bg-border" />
      {column('Sell offers (asks)', market.asks, 'no offers yet')}
    </div>
  )
}

export function TradesFeed({
  trades,
  youId,
  anonymous = true,
  max = 20,
}: {
  trades: Trade[]
  youId?: string
  anonymous?: boolean
  max?: number
}) {
  if (trades.length === 0) {
    return <p className="text-xs text-muted-foreground/60 font-mono text-center py-3">no trades yet</p>
  }
  return (
    <div className="flex flex-col gap-1">
      {trades.slice(0, max).map((t) => {
        const involved = t.buyerId === youId || t.sellerId === youId
        return (
          <div
            key={t.id}
            className={cn(
              'flex items-center justify-between text-xs font-mono py-1 px-2 rounded',
              involved && 'bg-accent/10',
            )}
          >
            {anonymous ? (
              <span className="text-muted-foreground">
                {involved ? (
                  <span className="text-primary font-bold">
                    you {t.buyerId === youId ? 'bought' : 'sold'}
                  </span>
                ) : (
                  'trade'
                )}{' '}
                {t.qty.toLocaleString()} cr
              </span>
            ) : (
              <span className="text-muted-foreground">
                <span className="text-primary font-bold">{t.buyerId}</span> bought{' '}
                {t.qty.toLocaleString()} cr from{' '}
                <span className="text-accent font-bold">{t.sellerId}</span>
              </span>
            )}
            <span className="text-foreground font-bold">@ {t.price}</span>
          </div>
        )
      })}
    </div>
  )
}

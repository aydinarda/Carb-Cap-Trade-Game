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

function OrderRow({
  order,
  mine,
  anonymous,
  onCancel,
}: {
  order: Order
  mine: boolean
  anonymous: boolean
  onCancel?: (id: string) => void
}) {
  // Anonymised for players (only your own orders are labelled); host sees ids.
  const label = mine ? 'you' : anonymous ? '•' : order.playerId
  return (
    <div
      className={cn(
        'flex items-center justify-between text-xs font-mono py-1 px-2 rounded',
        mine && 'bg-primary/10 border border-primary/30',
      )}
    >
      <span className={cn('font-bold w-9', mine ? 'text-primary' : 'text-muted-foreground')}>
        {label}
      </span>
      <span className="text-foreground">
        {order.remaining.toLocaleString()} <span className="text-muted-foreground">cr @</span>{' '}
        <span className={order.side === 'buy' ? 'text-primary' : 'text-accent'}>{order.price}</span>
      </span>
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
}: {
  market: MarketView
  youId?: string
  /** Hide other players' ids (default true; host passes false). */
  anonymous?: boolean
  onCancel?: (id: string) => void
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

import { X } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Trade } from '@shared/types'
import { cn } from '../../components/game/theme'
import { newFills, type FillNotice } from './fills'

const LIFETIME_MS = 4000
/** When a new one would make more, the oldest (the top one) goes. */
const MAX_VISIBLE = 5
/** Dragged further right than this, a notification is dismissed. */
const SWIPE_PX = 80

/**
 * Notifications from the bottom right, one for each of the player's fills: an order that matched
 * straight away, or a resting order someone else filled later. The live trades feed scrolls too
 * fast in a busy market to catch your own there. Each one stays 4 s and can be closed (× or a swipe
 * to the right); the newest is at the bottom.
 */
export function FillNotifications({ trades, youId }: { trades: Trade[]; youId: string }) {
  // Seeded with the fills already there at mount: after a reload, or opening the screen mid-market,
  // they are not news. A reconnect keeps the screen mounted, so fills made meanwhile do show.
  const seen = useRef<Set<string> | null>(null)
  if (seen.current === null) seen.current = new Set(trades.map((t) => t.id))
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [notices, setNotices] = useState<FillNotice[]>([])

  const dismiss = useCallback((key: string) => {
    clearTimeout(timers.current.get(key))
    timers.current.delete(key)
    setNotices((list) => list.filter((n) => n.key !== key))
  }, [])

  useEffect(() => {
    const fresh = newFills(trades, seen.current!, youId)
    if (fresh.length === 0) return
    for (const n of fresh) timers.current.set(n.key, setTimeout(() => dismiss(n.key), LIFETIME_MS))
    setNotices((list) => [...list, ...fresh].slice(-MAX_VISIBLE))
  }, [trades, youId, dismiss])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        <AnimatePresence initial={false}>
          {notices.map((n) => (
            <motion.div
              key={n.key}
              layout
              initial={{ x: '110%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '110%', opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={{ left: 0, right: 0.6 }}
              onDragEnd={(_, info) => {
                if (info.offset.x > SWIPE_PX) dismiss(n.key)
              }}
              className={cn(
                'pointer-events-auto relative cursor-grab rounded-lg border border-l-4 border-border bg-card/95 py-2.5 pl-3 pr-8 font-mono shadow-lg shadow-black/40 backdrop-blur active:cursor-grabbing',
                n.side === 'buy' ? 'border-l-market' : 'border-l-accent',
              )}
            >
              <button
                type="button"
                aria-label="Dismiss"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => dismiss(n.key)}
                className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                <X size={14} />
              </button>
              <p className={cn('text-sm font-bold', n.side === 'buy' ? 'text-market' : 'text-accent')}>
                You {n.side === 'buy' ? 'bought' : 'sold'} {n.qty.toLocaleString()} cr
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {n.trades === 1 ? `@ ${n.avgPrice}` : `avg ${n.avgPrice} · ${n.trades} trades`} · total{' '}
                {n.total.toLocaleString()}
              </p>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </MotionConfig>
  )
}

import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { Flame } from 'lucide-react'
import { useEffect } from 'react'
import type { PlayerSnapshot } from '@shared/types'
import { StatCard } from '../../components/game/cards'
import { EmissionHistoryChart } from '../../components/game/charts'

function CountUp({ value }: { value: number }) {
  const motionValue = useMotionValue(0)
  const rounded = useTransform(motionValue, (v) => v.toFixed(1))
  useEffect(() => {
    const controls = animate(motionValue, value, { duration: 1.4, ease: 'easeOut' })
    return controls.stop
  }, [value, motionValue])
  return <motion.span>{rounded}</motion.span>
}

export function EmissionsRevealScreen({ snap }: { snap: PlayerSnapshot }) {
  const expected = snap.you.plannedEmission
  const cover = snap.you.creditsHeld ?? 0
  const gap = Math.round((expected - cover) * 10) / 10
  const shortage = gap > 0

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-accent/40 bg-accent/5 p-6 text-center">
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
          <Flame size={13} className="text-accent" />
          Your expected emissions — Year {snap.currentYear}
        </div>
        <div
          className="text-5xl font-black font-mono text-accent"
          style={{ fontFamily: "'Unbounded', sans-serif" }}
        >
          <CountUp value={expected} />
        </div>
        <div className="text-sm text-muted-foreground mt-1">
          tCO₂ · mean — the actual is realized at year end
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Credits held"
          value={cover}
          unit="cr"
          hint={
            // Where the credits came from. Under a regime that does both, say both — the
            // mode name alone no longer answers it.
            snap.usesAuction
              ? (snap.you.freeAllocation ?? 0) > 0
                ? 'free allocation + won at auction'
                : 'won at auction'
              : 'free allocation'
          }
        />
        <StatCard label="Expected" value={expected} unit="tCO₂" tone="accent" />
        <StatCard
          label={shortage ? 'Expected shortage' : 'Expected surplus'}
          value={Math.abs(gap)}
          unit="tCO₂"
          tone={shortage ? 'bad' : 'good'}
          hint={shortage ? 'buy in the trade stage' : 'covered — surplus will expire'}
        />
      </div>

      <div className="rounded-xl border border-border bg-card/70 p-5">
        <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
          Your emission history — Year {snap.currentYear} highlighted
        </div>
        <EmissionHistoryChart you={snap.you} height={200} />
      </div>

      <p className="text-center text-sm text-muted-foreground font-mono animate-pulse">
        Waiting for the instructor to open the trade stage…
      </p>
    </div>
  )
}

import { Check, Landmark } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { PlayerSnapshot } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Progress } from '../../components/ui/progress'
import { Slider } from '../../components/ui/slider'
import { AllocationCard, WarningBanner } from '../../components/game/cards'
import { EmissionHistoryChart } from '../../components/game/charts'
import { useGame } from '../../net/GameContext'

export function CapStageScreen({ snap }: { snap: PlayerSnapshot }) {
  const { requestCredits } = useGame()
  const submitted = snap.you.regulatorRequest !== null
  const [qty, setQty] = useState<number>(snap.you.regulatorRequest ?? 0)
  const [busy, setBusy] = useState(false)

  // A new year resets the local input to the (empty) server decision
  useEffect(() => {
    setQty(snap.you.regulatorRequest ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.currentYear])

  const freeAllocation = snap.you.freeAllocation ?? 0
  const pool = snap.regulatorPool ?? 0
  const requestTotal = snap.regulatorRequestTotal ?? 0
  const oversubscribed = requestTotal > pool
  // Hard cap: you may request at most twice your fair share of the pool.
  const requestCap = snap.regulatorRequestCap
  const sliderMax = Math.max(1, requestCap)

  const submit = async () => {
    setBusy(true)
    const ok = await requestCredits(qty)
    setBusy(false)
    if (ok) toast.success(`Request submitted: ${qty} credits from the regulator`)
  }

  return (
    <div className="flex flex-col gap-5">
      <AllocationCard
        freeAllocation={freeAllocation}
        regulatorRequest={snap.you.regulatorRequest}
        mode={snap.capMode!}
      />

      <div className="rounded-xl border border-border bg-card/70 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
            <Landmark size={12} className="text-accent" />
            Regulator sale — Year {snap.currentYear}
          </div>
          <span className="text-xs font-mono text-accent border border-accent/30 rounded-full px-2 py-0.5">
            fixed price {snap.regulatorPrice} / credit
          </span>
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-xs font-mono text-muted-foreground mb-1.5">
            <span>Class requests vs pool</span>
            <span className={oversubscribed ? 'text-destructive' : 'text-foreground'}>
              {requestTotal.toLocaleString()} / {pool.toLocaleString()} cr
            </span>
          </div>
          <Progress value={Math.min(100, (requestTotal / Math.max(1, pool)) * 100)} className="h-2" />
        </div>

        <WarningBanner>
          Your expected Year {snap.currentYear} emission is{' '}
          <strong>{snap.you.expectedEmission ?? '—'} tCO₂</strong> — the actual is realized
          only at year end and may differ. The regulator pool is the baseline not given out
          for free; if the class requests more, everyone is cut pro-rata.
        </WarningBanner>

        <div className="flex items-center gap-4 mt-5">
          <Slider
            value={[Math.min(qty, sliderMax)]}
            onValueChange={([v]) => setQty(Math.min(v, requestCap))}
            max={sliderMax}
            step={1}
            className="flex-1"
          />
          <Input
            type="number"
            min={0}
            max={requestCap}
            value={qty}
            onChange={(e) => setQty(Math.min(requestCap, Math.max(0, Number(e.target.value))))}
            className="w-28 font-mono text-right"
          />
        </div>
        <div className="flex items-center justify-between mt-5">
          <span className="text-xs font-mono text-muted-foreground">
            Max request {requestCap.toLocaleString()} (2× fair share) · if granted in full:{' '}
            {(freeAllocation + qty).toLocaleString()} credits total
          </span>
          <Button onClick={() => void submit()} disabled={busy} className="font-bold">
            {submitted ? (
              <>
                <Check size={14} /> Update request
              </>
            ) : (
              'Submit request'
            )}
          </Button>
        </div>
        {submitted && (
          <p className="text-xs text-primary font-mono mt-2 flex items-center gap-1">
            <Check size={12} /> Submitted — you can change it until the instructor closes
            the stage.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card/70 p-5">
        <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
          Your emission history
        </div>
        <EmissionHistoryChart you={snap.you} height={180} />
      </div>
    </div>
  )
}

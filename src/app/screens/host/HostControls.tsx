import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { CapMode, SessionConfig } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { cn, MODE_LABELS } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

/** Cap-mechanism picker — usable in the lobby and between years (yearSummary). */
export function ModePicker({ capMode, compact }: { capMode: CapMode | null; compact?: boolean }) {
  const { hostAction } = useGame()
  const mode = capMode ? MODE_LABELS[capMode] : null
  return (
    <div>
      <div className="flex flex-col gap-2">
        {(Object.keys(MODE_LABELS) as CapMode[]).map((m) => (
          <button
            key={m}
            onClick={() => void hostAction('host:setCapMode', { mode: m })}
            className={cn(
              'text-left rounded-lg border px-3 py-2 text-sm transition-colors',
              capMode === m
                ? 'border-primary/60 bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:border-primary/30',
            )}
          >
            <span className="font-bold">{MODE_LABELS[m].label}</span>
            {!MODE_LABELS[m].implemented && (
              <span className="ml-2 text-[10px] font-mono uppercase text-accent">pending</span>
            )}
          </button>
        ))}
      </div>
      {mode && !compact && <p className="text-xs text-muted-foreground mt-3">{mode.desc}</p>}
    </div>
  )
}

/** Regulator price + penalty rates — editable in the lobby and between years. */
export function SettingsPanel({ config }: { config: SessionConfig }) {
  const { hostAction } = useGame()
  const [regulatorPrice, setRegulatorPrice] = useState(String(config.regulatorPrice))
  const [low, setLow] = useState(String(config.lowPenaltyRate))
  const [high, setHigh] = useState(String(config.highPenaltyRate))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRegulatorPrice(String(config.regulatorPrice))
    setLow(String(config.lowPenaltyRate))
    setHigh(String(config.highPenaltyRate))
  }, [config.regulatorPrice, config.lowPenaltyRate, config.highPenaltyRate])

  const save = async () => {
    setBusy(true)
    const ok = await hostAction('host:updateSettings', {
      regulatorPrice: Number(regulatorPrice),
      lowPenaltyRate: Number(low),
      highPenaltyRate: Number(high),
    })
    setBusy(false)
    if (ok) toast.success('Settings updated')
  }

  const field = (
    label: string,
    value: string,
    setValue: (v: string) => void,
    hint: string,
  ) => (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-foreground">{label}</div>
        <div className="text-[10px] text-muted-foreground font-mono">{hint}</div>
      </div>
      <Input
        type="number"
        min={0}
        step="0.1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-20 font-mono text-right shrink-0"
      />
    </div>
  )

  return (
    <div className="flex flex-col gap-3">
      {field('Regulator price', regulatorPrice, setRegulatorPrice, 'per credit, informational')}
      {field('Low penalty rate', low, setLow, 'pt/tCO₂ covered by leftovers')}
      {field('High penalty rate', high, setHigh, 'pt/tCO₂ uncovered')}
      <Button
        variant="outline"
        onClick={() => void save()}
        disabled={busy}
        className="font-mono text-xs"
      >
        Save settings
      </Button>
    </div>
  )
}

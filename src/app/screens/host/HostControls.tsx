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

/** Credit price + penalty rate + per-industry benchmarks — editable in the lobby and between years. */
export function SettingsPanel({ config }: { config: SessionConfig }) {
  const { hostAction } = useGame()
  const [regulatorPrice, setRegulatorPrice] = useState(String(config.regulatorPrice))
  const [sellPrice, setSellPrice] = useState(String(config.sellPrice))
  const [penalty, setPenalty] = useState(String(config.penaltyRate))
  const [benchmark, setBenchmark] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(config.benchmark).map(([k, v]) => [k, String(v)])),
  )
  const [auctionCapRatio, setAuctionCapRatio] = useState(String(config.auctionCapRatio))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRegulatorPrice(String(config.regulatorPrice))
    setSellPrice(String(config.sellPrice))
    setPenalty(String(config.penaltyRate))
    setAuctionCapRatio(String(config.auctionCapRatio))
    setBenchmark(Object.fromEntries(Object.entries(config.benchmark).map(([k, v]) => [k, String(v)])))
  }, [config.regulatorPrice, config.sellPrice, config.penaltyRate, config.auctionCapRatio, config.benchmark])

  const priceHigh = Number(penalty) <= Number(regulatorPrice)
  const arbitrage = Number(sellPrice) > Number(regulatorPrice)

  const save = async () => {
    setBusy(true)
    const ok = await hostAction('host:updateSettings', {
      regulatorPrice: Number(regulatorPrice),
      sellPrice: Number(sellPrice),
      penaltyRate: Number(penalty),
      auctionCapRatio: Number(auctionCapRatio),
      benchmark: Object.fromEntries(
        Object.entries(benchmark).map(([k, v]) => [k, Number(v)]),
      ),
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
      {field('Buy price', regulatorPrice, setRegulatorPrice, 'cost per credit bought')}
      {field('Sell price', sellPrice, setSellPrice, 'income per credit sold back')}
      {field('Penalty rate', penalty, setPenalty, 'cost per tCO₂ uncovered')}
      {field('Auction supply ratio', auctionCapRatio, setAuctionCapRatio, '× baseline (auctioning; ≤1 = scarcer)')}
      {priceHigh && (
        <p className="text-[10px] text-destructive font-mono">
          Penalty rate should exceed the buy price, or covering costs more than defaulting.
        </p>
      )}
      {arbitrage && (
        <p className="text-[10px] text-accent font-mono">
          ⚠ Sell price &gt; buy price: buy-low/sell-high arbitrage is possible (buying is
          unlimited, so profits can run away). Intentional? Useful to demonstrate arbitrage.
        </p>
      )}
      <div className="pt-1 mt-1 border-t border-border">
        <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider mb-2">
          Benchmark free credits (benchmarking mode)
        </div>
        <div className="flex flex-col gap-2">
          {Object.keys(benchmark).map((industry) =>
            field(
              industry,
              benchmark[industry],
              (v) => setBenchmark((b) => ({ ...b, [industry]: v })),
              'free credits per company',
            ),
          )}
        </div>
      </div>
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

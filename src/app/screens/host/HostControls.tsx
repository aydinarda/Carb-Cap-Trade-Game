import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Industry } from '@shared/constants'
import type { CapMode, HostConfigView } from '@shared/types'
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
export function SettingsPanel({ config }: { config: HostConfigView }) {
  const { hostAction } = useGame()
  const [penalty, setPenalty] = useState(String(config.penaltyRate))
  const [openingRef, setOpeningRef] = useState(String(config.openingReferenceFraction))
  const [freeCredit, setFreeCredit] = useState(String(config.freeCreditRatio))
  const [benchmark, setBenchmark] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(config.benchmark).map(([k, v]) => [k, String(v)])),
  )
  const [hybridShare, setHybridShare] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(config.hybridFreeShare).map(([k, v]) => [k, String(v)])),
  )
  const [auctionCapRatio, setAuctionCapRatio] = useState(String(config.auctionCapRatio))
  const [capReduction, setCapReduction] = useState(String(config.capReductionFactor))
  const [abateCap, setAbateCap] = useState(String(config.abatementLifetimeCap))
  const [abateFee, setAbateFee] = useState(String(config.abatementFixedCost))
  const [busy, setBusy] = useState(false)

  // Compared by value, not identity: `config.benchmark` arrives over the wire, so JSON.parse
  // hands us a fresh object on every snapshot. As an effect dependency that re-ran this
  // resync several times a second and wiped whatever the instructor was mid-way through
  // typing. The scalars above are primitives and compare fine as they are.
  const benchmarkKey = JSON.stringify(config.benchmark)
  const hybridShareKey = JSON.stringify(config.hybridFreeShare)
  useEffect(() => {
    setPenalty(String(config.penaltyRate))
    setOpeningRef(String(config.openingReferenceFraction))
    setFreeCredit(String(config.freeCreditRatio))
    setAuctionCapRatio(String(config.auctionCapRatio))
    setCapReduction(String(config.capReductionFactor))
    setAbateCap(String(config.abatementLifetimeCap))
    setAbateFee(String(config.abatementFixedCost))
    setBenchmark(Object.fromEntries(Object.entries(config.benchmark).map(([k, v]) => [k, String(v)])))
    setHybridShare(
      Object.fromEntries(Object.entries(config.hybridFreeShare).map(([k, v]) => [k, String(v)])),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config.penaltyRate,
    config.openingReferenceFraction,
    config.freeCreditRatio,
    config.auctionCapRatio,
    config.capReductionFactor,
    config.abatementLifetimeCap,
    config.abatementFixedCost,
    benchmarkKey,
    hybridShareKey,
  ])

  const save = async () => {
    setBusy(true)
    const ok = await hostAction('host:updateSettings', {
      penaltyRate: Number(penalty),
      openingReferenceFraction: Number(openingRef),
      freeCreditRatio: Number(freeCredit),
      auctionCapRatio: Number(auctionCapRatio),
      capReductionFactor: Number(capReduction),
      abatementLifetimeCap: Number(abateCap),
      abatementFixedCost: Number(abateFee),
      benchmark: Object.fromEntries(
        Object.entries(benchmark).map(([k, v]) => [k, Number(v)]),
      ),
      hybridFreeShare: Object.fromEntries(
        Object.entries(hybridShare).map(([k, v]) => [k, Number(v)]),
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
      {field('Penalty rate', penalty, setPenalty, 'cost per tCO₂ uncovered — market price ceiling')}
      {/* The strongest lever on where year one OPENS, and the only setting here that names
          a price rather than a quantity. Shown with the euro figure worked out, because a
          bare "0.25" tells an instructor nothing about what the class will see. */}
      {field(
        'Opening price',
        openingRef,
        setOpeningRef,
        `× penalty — year 1 starts near €${Math.round(Number(openingRef) * config.penaltyRate) || 0} before anything trades`,
      )}
      {field('Free credit ratio', freeCredit, setFreeCredit, '× baseline (grandfathering; ≤1 = scarcer)')}
      {field('Auction supply ratio', auctionCapRatio, setAuctionCapRatio, '× baseline (auctioning; ≤1 = scarcer)')}
      {field('Cap reduction / year', capReduction, setCapReduction, `auction supply, benchmark${config.applyLRFToGrandfathering ? ' AND free credits' : ''} × this each year (${Math.round((1 - Number(capReduction)) * 100)}%/yr tighter)`)}
      {/* Grandfathering used to be exempt from the reduction above, which made that setting
          do nothing at all in that mode. Surfaced so the exemption is a visible choice. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-foreground">Reduce free credits too</div>
          <div className="text-[10px] text-muted-foreground font-mono">
            apply the yearly cap reduction to grandfathering as well
          </div>
        </div>
        <button
          onClick={() =>
            void hostAction('host:updateSettings', {
              applyLRFToGrandfathering: !config.applyLRFToGrandfathering,
            })
          }
          className={cn(
            'shrink-0 text-[10px] font-mono uppercase tracking-wider border rounded-full px-3 py-1 transition-colors',
            config.applyLRFToGrandfathering
              ? 'text-primary border-primary/40 bg-primary/10'
              : 'text-muted-foreground border-border',
          )}
        >
          {config.applyLRFToGrandfathering ? 'on' : 'off'}
        </button>
      </div>
      {field('Abatement budget', abateCap, setAbateCap, 'most a company may EVER cut, as a fraction — a lifetime budget, not per year')}
      {/* Lowering the budget binds future installs only; nothing already built is undone. */}
      {field('Retrofit fee', abateFee, setAbateFee, '€ per t of baseline, charged AGAIN on every install step')}
      {/* Applies immediately — the pot is sized at year open either way, so a class can play
          the same year with and without the ceiling and compare. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-foreground">Price reserve</div>
          <div className="text-[10px] text-muted-foreground font-mono">
            releases up to 25% of the year's shortfall in steps from €
            {config.reserveSteps[0]?.triggerPrice ?? '—'}
          </div>
        </div>
        <button
          onClick={() =>
            void hostAction('host:updateSettings', { reserveEnabled: !config.reserveEnabled })
          }
          className={cn(
            'shrink-0 text-[10px] font-mono uppercase tracking-wider border rounded-full px-3 py-1 transition-colors',
            config.reserveEnabled
              ? 'text-primary border-primary/40 bg-primary/10'
              : 'text-muted-foreground border-border',
          )}
        >
          {config.reserveEnabled ? 'on' : 'off'}
        </button>
      </div>
      <div className="pt-1 mt-1 border-t border-border">
        <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider mb-2">
          Benchmark free credits (benchmarking mode)
        </div>
        <div className="flex flex-col gap-2">
          {(Object.keys(benchmark) as Industry[]).map((industry) => {
            // Restate the stringency from the value actually in force, so a hand-edit
            // shows immediately how far below the sector average it lands.
            const average = config.sectorAverage[industry]
            const value = Number(benchmark[industry])
            // Signed: the shipped benchmark opens ABOVE the sector average and is tightened
            // under it year by year, so this reads "below" or "above" as the number dictates.
            const gapPct =
              average > 0 && Number.isFinite(value)
                ? Math.round((1 - value / average) * 100)
                : null
            return field(
              industry,
              benchmark[industry],
              (v) => setBenchmark((b) => ({ ...b, [industry]: v })),
              gapPct !== null
                ? `${Math.abs(gapPct)}% ${gapPct >= 0 ? 'below' : 'above'} the ${average.toLocaleString()} t sector average`
                : 'free credits per company',
            )
          })}
        </div>
      </div>
      <div className="pt-1 mt-1 border-t border-border">
        <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider mb-2">
          Free allocation share (hybrid mode)
        </div>
        {/* The whole distributional decision of the hybrid mode, one number per sector.
            0 sends that sector to the auction for every tonne; 1 hands it the full
            benchmark. The hint works the share out in credits, because a bare "0.8" does
            not tell an instructor what the sector actually receives. */}
        <div className="flex flex-col gap-2">
          {(Object.keys(hybridShare) as Industry[]).map((industry) => {
            const share = Number(hybridShare[industry])
            const benchmarkValue = Number(benchmark[industry])
            const credits =
              Number.isFinite(share) && Number.isFinite(benchmarkValue)
                ? Math.round(share * benchmarkValue * 10) / 10
                : null
            return field(
              industry,
              hybridShare[industry],
              (v) => setHybridShare((h) => ({ ...h, [industry]: v })),
              share === 0
                ? 'no free credits — buys everything at the auction'
                : credits !== null
                  ? `${credits.toLocaleString()} cr free per company, out of the auction pool`
                  : 'share of the sector benchmark issued free (0–1)',
            )
          })}
        </div>
        <p className="text-[10px] text-muted-foreground font-mono mt-2">
          Free credits are deducted from the auction supply, not added to it — the cap stays
          the same however these are set.
        </p>
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

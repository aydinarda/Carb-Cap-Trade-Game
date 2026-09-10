import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Industry } from '@shared/constants'
import type { CapMode, HostConfigView, SubsidyWindow, TechUnlock } from '@shared/types'
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

/**
 * Green subsidy: announce a window in which retrofits are cheaper.
 *
 * The lead time is the event, not a technicality — see `Session.announceSubsidy`. The panel
 * therefore states the rounds the discount will actually apply to, rather than just "in 2
 * rounds", because the instructor is about to say that number out loud to the room.
 */
export function SubsidyPanel({
  subsidy,
  currentYear,
}: {
  subsidy: SubsidyWindow | null
  currentYear: number
}) {
  const { hostAction } = useGame()
  const [rounds, setRounds] = useState('3')
  const [busy, setBusy] = useState(false)

  const announce = async () => {
    setBusy(true)
    const ok = await hostAction('host:announceSubsidy', { rounds: Number(rounds) })
    setBusy(false)
    if (ok) toast.success(`Subsidy announced for ${rounds} round(s)`)
  }
  const cancel = async () => {
    setBusy(true)
    const ok = await hostAction('host:announceSubsidy', { rounds: 0 })
    setBusy(false)
    if (ok) toast.success('Subsidy withdrawn')
  }

  const live = subsidy && currentYear >= subsidy.fromYear && currentYear <= subsidy.toYear
  const pending = subsidy && currentYear < subsidy.fromYear

  return (
    <div className="flex flex-col gap-3">
      {subsidy ? (
        <div
          className={cn(
            'rounded-lg border px-3 py-2 text-xs font-mono',
            live
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-accent/50 bg-accent/10 text-accent',
          )}
        >
          <div className="font-bold">
            {live ? 'RUNNING' : 'ANNOUNCED'} · {Math.round(subsidy.discount * 100)}% off retrofits
          </div>
          <div className="text-muted-foreground mt-0.5">
            Rounds {subsidy.fromYear}–{subsidy.toYear}
            {pending && ` · starts in ${subsidy.fromYear - currentYear}`}
            {live && ` · ${subsidy.toYear - currentYear + 1} round(s) left`}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground font-mono">
          Announces a discount on abatement investment that starts a couple of rounds from
          now, so the class has to decide whether to retrofit today or wait for it.
        </p>
      )}

      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1 w-20">
          <label className="text-[10px] font-mono uppercase text-muted-foreground">Rounds</label>
          <Input
            type="number"
            min={1}
            max={20}
            value={rounds}
            onChange={(e) => setRounds(e.target.value)}
            className="font-mono"
          />
        </div>
        <Button onClick={() => void announce()} disabled={busy} className="font-bold flex-1">
          {subsidy ? 'Re-announce' : 'Announce subsidy'}
        </Button>
        {subsidy && (
          <Button variant="outline" onClick={() => void cancel()} disabled={busy} className="font-mono text-xs">
            Withdraw
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Technology breakthrough: raise the lifetime abatement budget.
 *
 * The cap is the ceiling the budget is raised TO. It is announced to the class rather than
 * quietly applied, because the point is that a new option has opened — a company that was
 * pinned at its old ceiling can suddenly cut further, and it has to notice in order to act.
 */
export function TechPanel({
  unlocks,
  currentYear,
  defaultCap,
  leadRounds,
}: {
  unlocks: TechUnlock[]
  currentYear: number
  defaultCap: number
  leadRounds: number
}) {
  const { hostAction } = useGame()
  const [cap, setCap] = useState(String(defaultCap))
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const announce = async () => {
    setBusy(true)
    const ok = await hostAction('host:announceTech', {
      cap: Number(cap),
      label: label.trim() || undefined,
    })
    setBusy(false)
    if (ok) toast.success(`Breakthrough announced — budget up to ${Math.round(Number(cap) * 100)}%`)
  }
  const withdraw = async () => {
    setBusy(true)
    const ok = await hostAction('host:announceTech', { cancel: true })
    setBusy(false)
    if (ok) toast.success('Latest breakthrough withdrawn')
  }

  const latest = unlocks[unlocks.length - 1]
  const live = latest && currentYear >= latest.fromYear

  return (
    <div className="flex flex-col gap-3">
      {latest ? (
        <div
          className={cn(
            'rounded-lg border px-3 py-2 text-xs font-mono',
            live
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-accent/50 bg-accent/10 text-accent',
          )}
        >
          <div className="font-bold">
            {live ? 'IN FORCE' : 'ANNOUNCED'} · budget up to{' '}
            {Math.round(latest.lifetimeCap * 100)}%
          </div>
          <div className="text-muted-foreground mt-0.5">
            {latest.label} · from round {latest.fromYear}
            {unlocks.length > 1 && ` · ${unlocks.length} announced in total`}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground font-mono">
          Raises how much of its own emissions a company may ever cut. Announce one when the
          class has spent its budget and the market has nothing left to respond with.
        </p>
      )}

      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1 w-20">
          <label className="text-[10px] font-mono uppercase text-muted-foreground">New cap</label>
          <Input
            type="number"
            min={0}
            max={1}
            step="0.05"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <label className="text-[10px] font-mono uppercase text-muted-foreground">
            Name (optional)
          </label>
          <Input
            value={label}
            placeholder="Carbon capture retrofit"
            onChange={(e) => setLabel(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => void announce()} disabled={busy} className="font-bold flex-1">
          Announce breakthrough
        </Button>
        {latest && (
          <Button variant="outline" onClick={() => void withdraw()} disabled={busy} className="font-mono text-xs">
            Withdraw
          </Button>
        )}
      </div>
      {leadRounds > 0 && (
        <p className="text-[10px] font-mono text-muted-foreground">
          Takes effect {leadRounds} round{leadRounds === 1 ? '' : 's'} after announcing.
        </p>
      )}
    </div>
  )
}

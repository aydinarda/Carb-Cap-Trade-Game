import { AlertTriangle, Construction, Gavel, Leaf, Trophy, TrendingDown, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Industry } from '@shared/constants'
import type {
  CapMode,
  LeaderboardRow,
  Phase,
  PlayerSettlement,
  PublicPlayerInfo,
} from '@shared/types'
import { cn, INDUSTRY_META, MODE_LABELS } from './theme'

export function IndustryBadge({ industry, size = 'md' }: { industry: Industry; size?: 'sm' | 'md' }) {
  const meta = INDUSTRY_META[industry]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono rounded-full border',
        size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-3 py-1',
      )}
      style={{
        color: meta.color,
        borderColor: `${meta.color}66`,
        background: `${meta.color}1a`,
      }}
    >
      {meta.icon}
      {industry}
    </span>
  )
}

const PHASE_LABELS: Record<Phase, string> = {
  lobby: 'Lobby — registration open',
  cap: 'Cap stage — decide credits to buy',
  reveal: 'Emissions revealed',
  trade: 'Trade stage',
  yearSummary: 'Year summary',
  ended: 'Game over',
}

export function PhaseBadge({ phase, year }: { phase: Phase; year: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-accent border border-accent/30 bg-accent/10 rounded-full px-3 py-1">
      {phase !== 'lobby' && phase !== 'ended' && <span className="font-bold">Year {year}</span>}
      {PHASE_LABELS[phase]}
    </span>
  )
}

export function StatCard({
  label,
  value,
  unit,
  hint,
  icon,
  tone = 'default',
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
  icon?: ReactNode
  tone?: 'default' | 'good' | 'bad' | 'accent'
}) {
  return (
    <div className="rounded-xl border border-border bg-card/70 p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          'text-2xl font-bold font-mono',
          tone === 'good' && 'text-primary',
          tone === 'bad' && 'text-destructive',
          tone === 'accent' && 'text-accent',
          tone === 'default' && 'text-foreground',
        )}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
        {unit && <span className="text-sm text-muted-foreground ml-1">{unit}</span>}
      </span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

export function AllocationCard({
  freeAllocation,
  regulatorRequest,
  mode,
}: {
  freeAllocation: number
  regulatorRequest: number | null
  mode: CapMode
}) {
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">
        <Leaf size={12} className="text-primary" />
        Your free credits · {MODE_LABELS[mode].label}
      </div>
      <div className="text-3xl font-bold font-mono text-primary">
        {freeAllocation.toLocaleString()}
        <span className="text-sm text-muted-foreground ml-1.5">credits</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5">
        {mode === 'grandfathering' &&
          "Proportional to your share of the class's total emissions over the past ten years (80% of the class baseline is distributed for free)."}
        {mode === 'benchmarking' &&
          'A flat allowance set for your industry — every company in the same industry gets the same free credits, regardless of its own history.'}
        {mode === 'auctioning' &&
          'No free credits under auctioning — every allowance must be bought from the regulator at the fixed price.'}
      </p>
      {regulatorRequest !== null && (
        <div className="mt-2 text-xs font-mono text-accent">
          + {regulatorRequest.toLocaleString()} credits requested from the regulator
        </div>
      )}
    </div>
  )
}

export function SettlementCard({
  settlement,
  scoreTotal,
}: {
  settlement: PlayerSettlement
  scoreTotal: number
}) {
  const noPenalty = settlement.penaltyCost === 0
  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        noPenalty ? 'border-primary/40 bg-primary/10' : 'border-destructive/40 bg-destructive/10',
      )}
    >
      <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider mb-1 text-muted-foreground">
        <Gavel size={12} className={noPenalty ? 'text-primary' : 'text-destructive'} />
        Cost settlement
      </div>
      <div
        className={cn(
          'text-2xl font-bold font-mono',
          noPenalty ? 'text-primary' : 'text-destructive',
        )}
      >
        +{settlement.yearCost.toLocaleString()}
        <span className="text-sm text-muted-foreground ml-1.5">cost this year</span>
      </div>
      <div className="text-xs font-mono text-muted-foreground mt-2 flex flex-col gap-0.5">
        <span>
          Credits bought: cost{' '}
          <span className="text-accent">{settlement.purchaseCost.toLocaleString()}</span>
        </span>
        <span>
          Shortage: <span className="text-foreground">{settlement.shortage}</span> tCO₂ → penalty{' '}
          <span className={noPenalty ? 'text-primary' : 'text-destructive'}>
            {settlement.penaltyCost.toLocaleString()}
          </span>
        </span>
      </div>
      <div className="text-xs font-mono text-muted-foreground mt-2 pt-2 border-t border-border">
        Total cost so far: <span className="text-foreground font-bold">{scoreTotal}</span>{' '}
        (lowest wins)
      </div>
    </div>
  )
}

export function LeaderboardTable({
  rows,
  youId,
}: {
  rows: LeaderboardRow[]
  youId?: string
}) {
  return (
    <div className="flex flex-col divide-y divide-border">
      {rows.map((row, i) => {
        const meta = INDUSTRY_META[row.industry]
        return (
          <div
            key={row.id}
            className={cn(
              'flex items-center gap-3 py-2 px-1 text-sm',
              row.id === youId && 'bg-primary/5 rounded',
            )}
          >
            <span className="w-7 text-center font-mono font-bold text-muted-foreground">
              {i === 0 ? <Trophy size={14} className="text-accent inline" /> : i + 1}
            </span>
            <span className="font-mono font-bold w-9">{row.id}</span>
            <span className="flex-1 truncate text-foreground">{row.name}</span>
            <span style={{ color: meta.color }}>{meta.icon}</span>
            <span
              className={cn(
                'font-mono font-bold w-20 text-right',
                row.score === 0 ? 'text-primary' : 'text-foreground',
              )}
            >
              {row.score.toLocaleString()}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function NetPositionCard({ netPosition }: { netPosition: number }) {
  const shortage = netPosition > 0
  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        shortage ? 'border-destructive/40 bg-destructive/10' : 'border-primary/40 bg-primary/10',
      )}
    >
      <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider mb-1 text-muted-foreground">
        {shortage ? (
          <TrendingUp size={12} className="text-destructive" />
        ) : (
          <TrendingDown size={12} className="text-primary" />
        )}
        Net position
      </div>
      <div
        className={cn(
          'text-3xl font-bold font-mono',
          shortage ? 'text-destructive' : 'text-primary',
        )}
      >
        {shortage ? '+' : ''}
        {netPosition.toLocaleString()}
        <span className="text-sm text-muted-foreground ml-1.5">tCO₂</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5">
        {shortage
          ? 'Shortage: you emitted more than your credits cover. You would need to buy in the trade stage.'
          : 'Surplus: your credits cover your emissions. You could sell the surplus in the trade stage.'}
      </p>
    </div>
  )
}

export function PendingMechanismNotice({ title, note }: { title: string; note?: string }) {
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-5 flex gap-3">
      <Construction size={20} className="text-accent shrink-0 mt-0.5" />
      <div>
        <div className="text-sm font-bold text-accent mb-1">{title}</div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {note ?? 'Details are pending from the game designer. The interface is ready — the mechanics will be plugged in once they are specified.'}
        </p>
      </div>
    </div>
  )
}

export function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn('inline-block w-2 h-2 rounded-full', connected ? 'bg-primary' : 'bg-muted-foreground/40')}
      title={connected ? 'connected' : 'disconnected'}
    />
  )
}

export function RosterList({ roster, youId }: { roster: PublicPlayerInfo[]; youId?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {roster.map((p) => {
        const meta = INDUSTRY_META[p.industry]
        return (
          <span
            key={p.id}
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-mono rounded-full border px-2.5 py-1',
              p.id === youId
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border bg-card/60 text-muted-foreground',
            )}
          >
            <ConnectionDot connected={p.connected} />
            <span className="font-bold">{p.id}</span>
            {p.name}
            <span style={{ color: meta.color }}>{meta.icon}</span>
          </span>
        )
      })}
    </div>
  )
}

export function WarningBanner({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent flex items-center gap-2">
      <AlertTriangle size={13} className="shrink-0" />
      {children}
    </div>
  )
}

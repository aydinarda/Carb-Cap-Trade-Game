import { AlertTriangle, Bot, ChevronRight, Gavel, Leaf, Trophy } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Industry } from '@shared/constants'
import type {
  CapMode,
  LeaderboardRow,
  Phase,
  PlayerSettlement,
  PublicPlayerInfo,
} from '@shared/types'
import { BOT_LABELS, cn, INDUSTRY_META, MODE_LABELS } from './theme'

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
  reveal: 'Expected emissions',
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

/**
 * Tone is a ROLE, not a colour: the palette maps each one to a fixed hue everywhere in the
 * game, so a caller picks what the number means and never which colour it should be.
 *
 *  good/primary  lime   — abatement, compliance, the player's own position
 *  market        cyan   — anything discovered on the secondary market
 *  accent        amber  — the sell side and the primary auction
 *  bad           coral  — a shortage, a cost, a penalty
 *  insight       purple — the optimum and analysis of it
 */
export type StatTone = 'default' | 'good' | 'bad' | 'accent' | 'market' | 'insight'

const TONE_TEXT: Record<StatTone, string> = {
  default: 'text-foreground',
  good: 'text-primary',
  bad: 'text-destructive',
  accent: 'text-accent',
  market: 'text-market',
  insight: 'text-insight',
}

const TONE_FRAME: Record<StatTone, string> = {
  default: 'border-border bg-card',
  good: 'border-primary/30 bg-primary/5',
  bad: 'border-destructive/35 bg-destructive/5',
  accent: 'border-accent/30 bg-accent/5',
  market: 'border-market/30 bg-market/5',
  insight: 'border-insight/30 bg-insight/5',
}

export function StatCard({
  label,
  value,
  unit,
  hint,
  icon,
  tone = 'default',
  labelTone,
  hintTone,
  aside,
  emphasis = false,
}: {
  label: string
  value: string | number
  unit?: string
  hint?: ReactNode
  icon?: ReactNode
  tone?: StatTone
  /**
   * Colour for the LABEL. Defaults to muted, because a row of four cards whose headings all
   * shout is a row with no emphasis at all. Set it on the one card that is an alarm — a
   * shortage heading in coral is read before the number under it, which is the point.
   */
  labelTone?: StatTone
  /** Colour for the hint line, when the hint is itself a verdict ("cheaper than market"). */
  hintTone?: StatTone
  /** Rendered to the right of the value — the sparkline slot. */
  aside?: ReactNode
  /** Tints the card's border and background with the tone, for the cards that lead a screen. */
  emphasis?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4 flex flex-col gap-1',
        emphasis ? TONE_FRAME[tone] : 'border-border bg-card/70',
      )}
    >
      <span
        className={cn(
          'text-xs font-mono uppercase tracking-wider flex items-center gap-1.5',
          labelTone ? TONE_TEXT[labelTone] : 'text-muted-foreground',
        )}
      >
        {icon}
        {label}
      </span>
      <div className="flex items-end justify-between gap-3">
        <span
          className={cn(
            'font-bold font-mono leading-none',
            emphasis ? 'text-3xl' : 'text-2xl',
            TONE_TEXT[tone],
          )}
        >
          {typeof value === 'number' ? value.toLocaleString() : value}
          {unit && <span className="text-sm text-muted-foreground ml-1 font-normal">{unit}</span>}
        </span>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
      {hint && (
        <span className={cn('text-xs', hintTone ? TONE_TEXT[hintTone] : 'text-muted-foreground')}>
          {hint}
        </span>
      )}
    </div>
  )
}

/**
 * A bare price line — no axes, no labels, no tooltip.
 *
 * Deliberately not a chart: it answers "which way has this been going?" beside the number
 * that says where it is now, and anything more would compete with the number. Drawn as raw
 * SVG rather than through the chart library because it renders at 30 pixels tall inside a
 * stat card, where a responsive container costs more than it can possibly repay.
 *
 * A flat series (every point equal, or a single point) is drawn as a flat line through the
 * middle rather than being scaled to nothing — dividing by a zero range is how a steady
 * price ends up looking like a crash.
 */
export function Sparkline({
  points,
  color,
  width = 84,
  height = 30,
}: {
  points: number[]
  color: string
  width?: number
  height?: number
}) {
  if (points.length < 2) return null
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const range = hi - lo
  const pad = 3
  const x = (i: number) => (i / (points.length - 1)) * (width - pad * 2) + pad
  const y = (v: number) =>
    range === 0 ? height / 2 : height - pad - ((v - lo) / range) * (height - pad * 2)
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(last)} r={2.5} fill={color} />
    </svg>
  )
}

/**
 * The compliance decision, priced.
 *
 * The whole lesson of a cap-and-trade game is that a company chooses between three costs, so
 * the screen states all three in the same units at the same moment instead of leaving the
 * student to multiply.
 *
 * TWO THINGS THIS IS CAREFUL ABOUT, because getting either wrong teaches the opposite of
 * what the game is for:
 *
 *  1. **Abatement does not settle this year.** Capacity is paid for now and comes online at
 *     the next year open, so it cannot close today's gap — it closes the SAME gap in every
 *     following year. Listing it beside "buy" as an equivalent way to comply would be a
 *     straightforward lie about the mechanism, so it is separated and labelled.
 *  2. **The penalty is not a purchase.** An uncovered tonne is fined AND still carried as
 *     make-good debt into next year (see `settleYear`), so the fine is not a price at which
 *     a player may simply opt out. Presenting it as the third column of a shopping list —
 *     which is how a naive reading of the numbers goes — is what makes students treat it as
 *     a ceiling. The qualifier says so in the row itself.
 */
export function ComplianceStrip({
  gap,
  buyCost,
  penaltyCost,
  penaltyRate,
  abateCost,
  abateBlockedReason,
}: {
  /** Tonnes still to cover this year. Positive = short; this component renders nothing at 0. */
  gap: number
  /** Gap × the current market price, or null when nothing has traded yet. */
  buyCost: number | null
  /** Gap × penaltyRate. */
  penaltyCost: number
  penaltyRate: number
  /** What it would cost to install enough capacity to cut `gap` tonnes — from NEXT year. */
  abateCost: number | null
  /** Why the abate option is unavailable, when it is (headroom under the lifetime cap). */
  abateBlockedReason?: string
}) {
  if (gap <= 0) return null
  const cheapest =
    buyCost !== null && abateCost !== null ? (buyCost <= abateCost ? 'buy' : 'abate') : null
  const Cheaper = ({ tone }: { tone: string }) => (
    <span className={cn('ml-1.5 text-[10px] uppercase tracking-wider', tone)}>cheaper</span>
  )

  return (
    <div className="rounded-xl border border-border bg-card/70 px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2.5 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <Leaf size={15} className="text-primary shrink-0" />
        Cover <strong className="font-mono">{gap}</strong> tCO₂ to comply.
      </span>

      <span className="h-4 w-px bg-border hidden sm:block" aria-hidden="true" />

      <span className="font-mono text-market">
        Buy in market: <strong>{buyCost === null ? '—' : `~${buyCost.toLocaleString()} cr`}</strong>
        {cheapest === 'buy' && <Cheaper tone="text-market/70" />}
      </span>

      <span className="text-muted-foreground">or</span>

      {/*
        The cost here is the REAL charge — the retrofit fee plus the integral of the MAC
        curve between the installed level and the one that closes the gap — not
        `gap × next-tonne cost`. The linear version understates a small cut by the whole fee
        (hundreds to over a thousand credits, since the fee scales with baseline emissions
        and is charged again on every step), so a student who read it would press the button
        and be charged several times what the screen quoted.

        The "from next year" note is not decoration either: capacity comes online at the next
        year open, so this does not settle today's shortfall. It is the cheaper answer to the
        SAME gap in every following year, which is what makes it worth comparing at all.
      */}
      <span className="font-mono text-primary">
        Abate: <strong>{abateCost === null ? '—' : `~${abateCost.toLocaleString()} cr`}</strong>
        <span className="ml-1.5 text-[11px] text-muted-foreground">
          {abateBlockedReason ?? 'from next year'}
        </span>
        {cheapest === 'abate' && !abateBlockedReason && <Cheaper tone="text-primary/70" />}
      </span>

      <span className="h-4 w-px bg-border hidden sm:block" aria-hidden="true" />

      {/* Short, because the qualifier that matters — that the fine does not discharge the
          obligation — is already on the shortage card above it, and saying it twice in one
          viewport is how a caveat stops being read. */}
      <span className="font-mono text-destructive">
        Uncovered: <strong>{penaltyCost.toLocaleString()} cr</strong> penalty
        <span className="ml-1.5 text-[11px] text-destructive/70">({penaltyRate}/t)</span>
      </span>
    </div>
  )
}

export function AllocationCard({
  freeAllocation,
  mode,
}: {
  freeAllocation: number
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
          "Proportional to your share of the class's total emissions over the past ten years — the more you have emitted, the more you are given. The class total shrinks every year."}
        {mode === 'benchmarking' &&
          'The benchmark set for your sector — every company in it gets the same free credits regardless of its own history. It starts near the sector average and is cut every year, so an average emitter runs short as the game goes on.'}
        {mode === 'auctioning' &&
          'No free credits under auctioning — every allowance must be bought at the sealed-bid auction or on the market.'}
        {mode === 'hybrid' &&
          "The share of your sector's benchmark the regulator issues free. Everything given away this year came out of the auction supply, so the sectors bidding for the rest are paying for it — the cap itself does not move."}
      </p>
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
          settlement.yearCost <= 0 ? 'text-primary' : noPenalty ? 'text-foreground' : 'text-destructive',
        )}
      >
        {settlement.yearCost >= 0 ? '+' : ''}
        {settlement.yearCost.toLocaleString()}
        <span className="text-sm text-muted-foreground ml-1.5">
          {settlement.yearCost < 0 ? 'net gain this year' : 'cost this year'}
        </span>
      </div>
      <div className="text-xs font-mono text-muted-foreground mt-2 flex flex-col gap-0.5">
        <span>
          Emission cuts: cost{' '}
          <span className="text-destructive">{settlement.abatementCost.toLocaleString()}</span>
        </span>
        <span>
          Bought: cost{' '}
          <span className="text-destructive">{settlement.purchaseCost.toLocaleString()}</span>
        </span>
        <span>
          Sold: income{' '}
          <span className="text-primary">{settlement.sellIncome.toLocaleString()}</span>
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
        (your bill — the leaderboard scores it against your own optimum)
      </div>
    </div>
  )
}

export function LeaderboardTable({
  rows,
  youId,
  onRowClick,
}: {
  rows: LeaderboardRow[]
  youId?: string
  /** When provided (host), rows become clickable to open the player's history. */
  onRowClick?: (id: string) => void
}) {
  return (
    <div className="flex flex-col divide-y divide-border">
      {rows.map((row, i) => {
        const meta = INDUSTRY_META[row.industry]
        return (
          <div
            key={row.id}
            onClick={onRowClick ? () => onRowClick(row.id) : undefined}
            className={cn(
              'flex items-center gap-3 py-2 px-1 text-sm',
              row.id === youId && 'bg-primary/5 rounded',
              onRowClick && 'cursor-pointer hover:bg-accent/10 rounded transition-colors',
            )}
          >
            <span className="w-7 text-center font-mono font-bold text-muted-foreground">
              {i === 0 ? <Trophy size={14} className="text-accent inline" /> : i + 1}
            </span>
            <span className="font-mono font-bold w-9">{row.id}</span>
            <span className="flex-1 truncate text-foreground inline-flex items-center gap-1.5">
              {row.isBot && <Bot size={12} className="text-accent shrink-0" />}
              {row.name}
              {row.isBot && row.botType && (
                <span className="text-[9px] font-mono uppercase tracking-wider text-accent/80">
                  {BOT_LABELS[row.botType]}
                </span>
              )}
            </span>
            {row.isBot ? (
              <span className="text-[10px]" style={{ color: meta.color }} title="bot (cosmetic sector)">
                🤖
              </span>
            ) : (
              <span style={{ color: meta.color }}>{meta.icon}</span>
            )}
            {/* Points, not the raw gap. Higher is better, which is the direction a class
                expects a leaderboard to run — the gap itself is still one hover away, and
                the host sees the full breakdown in the history dialog. Pure-trader bots
                have no points (see LeaderboardRow.points) and fall back to their P&L. */}
            <span
              className={cn(
                'font-mono font-bold w-20 text-right',
                row.points === null
                  ? 'text-muted-foreground'
                  : row.points >= 75
                    ? 'text-primary'
                    : row.points >= 40
                      ? 'text-foreground'
                      : 'text-muted-foreground',
              )}
              title={
                row.points === null
                  ? 'raw cumulative P&L (points are N/A for pure-trader bots)'
                  : `${row.points} / 100 — trading gap ${row.tradingGap} + investment gap ${row.investmentGap} € per baseline tonne, lower gap scores higher`
              }
            >
              {row.points === null ? row.normalizedScore.toLocaleString() : `${row.points}`}
            </span>
          </div>
        )
      })}
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

/**
 * A short, genuine warning — one or two lines. NOT a place for rules copy: for "how this
 * stage works", use `FlowHint`, which stays legible at a glance.
 *
 * The prose is wrapped in its own element on purpose. This container is a flex row, and a
 * flex container makes a separate item out of every child — including each run of bare
 * text between two `<strong>` tags. A paragraph passed in directly was therefore shredded
 * into a dozen narrow columns, one word wide, which is what this used to look like.
 */
export function WarningBanner({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent flex items-start gap-2">
      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
  )
}

/**
 * How the current stage works, as a sequence: `step → step → step`.
 *
 * Replaces the paragraph-in-a-banner pattern. Rules copy nobody reads is worse than no
 * copy, and this stage's rules are genuinely sequential, so the arrows carry the meaning
 * that a wall of prose was burying. Steps wrap as a group on a narrow screen and never
 * break mid-phrase, because each step is a single flex item.
 *
 * Keep steps to about three to six words. If one needs a sentence, it is not a step.
 */
export function FlowHint({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
      {steps.map((step, i) => (
        <li key={i} className="flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground">
          {i > 0 && <ChevronRight size={11} className="shrink-0 opacity-40" aria-hidden />}
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}

import {
  ArrowRight,
  BookOpen,
  Eye,
  EyeOff,
  Flag,
  History,
  Landmark,
  SkipForward,
  Trophy,
} from 'lucide-react'
import { useState } from 'react'
import type { HostSnapshot, Phase } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import {
  ConnectionDot,
  IndustryBadge,
  LeaderboardTable,
  StatCard,
} from '../../components/game/cards'
import { ClassYearChart, IndustryBreakdownChart } from '../../components/game/charts'
import { MarketTicker, OrderBook, TradesFeed } from '../../components/game/market'
import { cn } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'
import { ModePicker, SettingsPanel } from './HostControls'

/** The single valid next action per phase — keeps the instructor on rails. */
const NEXT_ACTION: Partial<
  Record<Phase, { event: 'host:closeCapStage' | 'host:openTrade' | 'host:closeTrade' | 'host:advanceYear'; label: (year: number) => string }>
> = {
  cap: { event: 'host:closeCapStage', label: () => 'Close cap stage & reveal emissions' },
  reveal: { event: 'host:openTrade', label: () => 'Open the market' },
  trade: { event: 'host:closeTrade', label: () => 'Close market & settle penalties' },
  yearSummary: { event: 'host:advanceYear', label: (y) => `Start Year ${y + 1}` },
}

export function HostGameScreen({ snap }: { snap: HostSnapshot }) {
  const { hostAction } = useGame()
  const [busy, setBusy] = useState(false)
  const [showPlayers, setShowPlayers] = useState(false)
  const agg = snap.classAggregate
  const next = NEXT_ACTION[snap.phase]
  const submittedPct =
    snap.players.length > 0 ? (agg.submittedCount / snap.players.length) * 100 : 0
  const requests = agg.totalRegulatorRequests ?? 0
  const pool = snap.regulatorPool ?? 0

  const run = async (event: NonNullable<typeof next>['event']) => {
    setBusy(true)
    await hostAction(event)
    setBusy(false)
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Control bar */}
      <div className="rounded-xl border border-accent/30 bg-card/80 p-4 flex flex-wrap items-center gap-4 sticky top-3 z-20 backdrop-blur">
        <div className="flex-1 min-w-48">
          {snap.phase === 'cap' && (
            <div>
              <div className="flex justify-between text-xs font-mono text-muted-foreground mb-1.5">
                <span>Requests submitted</span>
                <span className="text-foreground">
                  {agg.submittedCount} / {snap.players.length}
                </span>
              </div>
              <Progress value={submittedPct} className="h-2" />
            </div>
          )}
          {snap.phase === 'trade' && snap.market && (
            <span className="text-sm text-muted-foreground font-mono">
              Market open · {snap.market.trades.length} trade
              {snap.market.trades.length === 1 ? '' : 's'} · last price{' '}
              <span className="text-foreground font-bold">{snap.market.lastPrice ?? '—'}</span>
            </span>
          )}
          {(snap.phase === 'reveal' || snap.phase === 'yearSummary') && (
            <span className="text-sm text-muted-foreground font-mono">
              Year {snap.currentYear} · waiting on you to advance the game
            </span>
          )}
          {snap.phase === 'ended' && (
            <span className="text-sm text-primary font-mono font-bold">
              Game over — final results below
            </span>
          )}
        </div>
        {next && (
          <Button onClick={() => void run(next.event)} disabled={busy} className="font-bold">
            {snap.phase === 'yearSummary' ? <SkipForward size={15} /> : <ArrowRight size={15} />}
            {next.label(snap.currentYear)}
          </Button>
        )}
        {snap.phase !== 'ended' && (
          <Button
            variant="outline"
            onClick={() => void hostAction('host:endGame')}
            className="font-mono text-xs"
          >
            <Flag size={13} /> End game
          </Button>
        )}
      </div>

      {/* Aggregate stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Cap (free credit limit)"
          value={snap.freeCreditLimit ?? 0}
          unit="cr"
          hint="80% of class baseline, fixed"
        />
        <StatCard
          label="Regulator pool"
          value={`${requests.toLocaleString()} / ${pool.toLocaleString()}`}
          unit="cr"
          tone={requests > pool ? 'bad' : 'default'}
          hint={requests > pool ? 'oversubscribed — pro-rata' : 'requests vs pool (20%)'}
          icon={<Landmark size={12} />}
        />
        <StatCard
          label="Class realized"
          value={agg.totalRealized ?? '—'}
          unit={agg.totalRealized !== null ? 'tCO₂' : undefined}
          tone={
            agg.totalRealized !== null && snap.freeCreditLimit !== null
              ? agg.totalRealized > snap.freeCreditLimit
                ? 'bad'
                : 'good'
              : 'default'
          }
          hint={agg.totalRealized === null ? 'hidden until reveal' : undefined}
        />
        <StatCard
          label="Penalties this year"
          value={agg.totalPenaltyThisYear ?? '—'}
          unit={agg.totalPenaltyThisYear !== null ? 'pt' : undefined}
          tone={agg.totalPenaltyThisYear ? 'bad' : 'default'}
          hint={
            agg.leftoverDistributed !== null
              ? `${agg.leftoverDistributed} cr leftover distributed`
              : 'after market close'
          }
        />
      </div>

      {/* Trade phase: live market */}
      {snap.phase === 'trade' && snap.market && (
        <>
          <MarketTicker market={snap.market} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="rounded-xl border border-border bg-card/70 p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
                <BookOpen size={12} className="text-primary" />
                Live order book
              </div>
              <OrderBook market={snap.market} />
            </div>
            <div className="rounded-xl border border-border bg-card/70 p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
                <History size={12} className="text-primary" />
                Trades feed
              </div>
              <TradesFeed trades={snap.market.trades} max={14} />
            </div>
          </div>
        </>
      )}

      {/* Year summary / end: leaderboard + between-year controls */}
      {(snap.phase === 'yearSummary' || snap.phase === 'ended') && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
          <div className="rounded-xl border border-border bg-card/70 p-5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
              <Trophy size={12} className="text-accent" />
              Leaderboard — fewest penalty points wins
            </div>
            <LeaderboardTable rows={snap.leaderboard} />
          </div>
          {snap.phase === 'yearSummary' && (
            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-accent/30 bg-card/70 p-5">
                <div className="text-xs text-accent font-mono uppercase tracking-wider mb-3">
                  Cap mechanism for Year {snap.currentYear + 1}
                </div>
                <ModePicker capMode={snap.capMode} compact />
              </div>
              <div className="rounded-xl border border-border bg-card/70 p-5">
                <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
                  Game settings
                </div>
                <SettingsPanel config={snap.config} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            Industry breakdown — Year {snap.currentYear}
          </div>
          <IndustryBreakdownChart aggregate={agg} />
        </div>
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            Class emissions vs cap, by year
          </div>
          {agg.yearHistory.length > 0 ? (
            <ClassYearChart aggregate={agg} />
          ) : (
            <p className="text-sm text-muted-foreground font-mono py-16 text-center">
              Appears after the first reveal.
            </p>
          )}
        </div>
      </div>

      {/* Per-player table (off by default: projector-friendly) */}
      <div className="rounded-xl border border-border bg-card/70 p-5">
        <button
          onClick={() => setShowPlayers((v) => !v)}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground font-mono uppercase tracking-wider transition-colors"
        >
          {showPlayers ? <EyeOff size={13} /> : <Eye size={13} />}
          {showPlayers ? 'Hide' : 'Show'} per-company table
        </button>
        {showPlayers && (
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs font-mono uppercase tracking-wider text-muted-foreground text-left">
                  <th className="py-2 pr-3 font-normal">Company</th>
                  <th className="py-2 pr-3 font-normal">Industry</th>
                  <th className="py-2 pr-3 font-normal text-right">Free</th>
                  <th className="py-2 pr-3 font-normal text-right">Regulator</th>
                  <th className="py-2 pr-3 font-normal text-right">Held</th>
                  <th className="py-2 pr-3 font-normal text-right">Realized</th>
                  <th className="py-2 pr-3 font-normal text-right">Net</th>
                  <th className="py-2 font-normal text-right">Penalty Σ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {snap.players.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2 pr-3 font-mono">
                      <span className="inline-flex items-center gap-2">
                        <ConnectionDot connected={p.connected} />
                        <span className="font-bold">{p.id}</span> {p.name}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <IndustryBadge industry={p.industry} size="sm" />
                    </td>
                    <td className="py-2 pr-3 font-mono text-right">
                      {p.freeAllocation?.toLocaleString() ?? '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-right">
                      {p.regulatorGranted !== null
                        ? p.regulatorGranted.toLocaleString()
                        : (p.regulatorRequest?.toLocaleString() ?? '—')}
                    </td>
                    <td className="py-2 pr-3 font-mono text-right">
                      {p.creditsHeld?.toLocaleString() ?? '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-right">
                      {p.realized?.toLocaleString() ?? '—'}
                    </td>
                    <td
                      className={cn(
                        'py-2 pr-3 font-mono text-right font-bold',
                        p.netPosition !== null && p.netPosition > 0 && 'text-destructive',
                        p.netPosition !== null && p.netPosition <= 0 && 'text-primary',
                      )}
                    >
                      {p.netPosition !== null
                        ? `${p.netPosition > 0 ? '+' : ''}${p.netPosition.toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="py-2 font-mono text-right text-muted-foreground">
                      {p.penaltyPoints.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

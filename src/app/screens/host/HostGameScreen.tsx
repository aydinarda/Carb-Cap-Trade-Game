import {
  ArrowRight,
  Bot,
  Eye,
  EyeOff,
  Flag,
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
import { MarketTicker, OrderBook, TradesFeed } from '../../components/game/market'
import { PlayerHistoryDialog } from './PlayerHistoryDialog'
import { ClassYearChart, IndustryBreakdownChart } from '../../components/game/charts'
import { cn } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'
import { ModePicker, SettingsPanel } from './HostControls'

/** The single valid next action per phase — keeps the instructor on rails. */
const NEXT_ACTION: Partial<
  Record<Phase, { event: 'host:closeCapStage' | 'host:openTrade' | 'host:closeTrade' | 'host:advanceYear'; label: (year: number) => string }>
> = {
  cap: { event: 'host:closeCapStage', label: () => 'Close cap stage → expected emissions' },
  reveal: { event: 'host:openTrade', label: () => 'Open the market' },
  trade: { event: 'host:closeTrade', label: () => 'Close market → realize & settle' },
  yearSummary: { event: 'host:advanceYear', label: (y) => `Start Year ${y + 1}` },
}

export function HostGameScreen({ snap }: { snap: HostSnapshot }) {
  const { hostAction } = useGame()
  const [busy, setBusy] = useState(false)
  const [showPlayers, setShowPlayers] = useState(false)
  const [historyId, setHistoryId] = useState<string | null>(null)
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
          {/* Only a cap-stage auction has something to wait on; the free-allocation
              modes have already issued everything, so report the scarcity instead. */}
          {snap.phase === 'cap' && snap.capMode === 'auctioning' && (
            <div>
              <div className="flex justify-between text-xs font-mono text-muted-foreground mb-1.5">
                <span>Bids submitted</span>
                <span className="text-foreground">
                  {agg.submittedCount} / {snap.players.length}
                </span>
              </div>
              <Progress value={submittedPct} className="h-2" />
            </div>
          )}
          {snap.phase === 'cap' && snap.capMode !== 'auctioning' && (
            <span className="text-sm text-muted-foreground font-mono">
              Allocations issued ·{' '}
              <span className="text-foreground font-bold">
                {(agg.totalFreeAllocation ?? 0).toLocaleString()}
              </span>{' '}
              cr against{' '}
              <span className="text-foreground font-bold">
                {(agg.totalExpected ?? 0).toLocaleString()}
              </span>{' '}
              t expected
            </span>
          )}
          {snap.phase === 'trade' && (
            <span className="text-sm text-muted-foreground font-mono">
              Market open · last price{' '}
              <span className="text-foreground font-bold">{snap.market?.lastPrice ?? '—'}</span> ·{' '}
              {snap.market?.volume ?? 0} cr traded
            </span>
          )}
          {(snap.phase === 'reveal' || snap.phase === 'yearSummary') && (
            <span className="text-sm text-muted-foreground font-mono">
              {snap.capMode === 'auctioning' && snap.auctionPrice !== null ? (
                <>
                  Auction cleared at{' '}
                  <span className="text-accent font-bold">{snap.auctionPrice}</span> / credit ·{' '}
                </>
              ) : snap.prevMarketPrice !== null ? (
                <>
                  Last settled at{' '}
                  <span className="text-accent font-bold">{snap.prevMarketPrice}</span> / credit ·{' '}
                </>
              ) : null}
              Year {snap.currentYear} · waiting on you to advance
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
          label="Free allocation (this year)"
          value={agg.totalFreeAllocation ?? 0}
          unit="cr"
          hint="this year, by mode"
        />
        {snap.capMode === 'auctioning' ? (
          <StatCard
            label="Auction demand / supply"
            value={`${requests.toLocaleString()} / ${pool.toLocaleString()}`}
            unit="cr"
            tone={requests > pool ? 'bad' : 'default'}
            hint={requests > pool ? 'oversubscribed — price bites' : 'bids vs supply'}
            icon={<Landmark size={12} />}
          />
        ) : (
          // No primary sale: the interesting number is how far the free allocation
          // falls short of what the class expects to emit — the scarcity it must
          // close by cutting or trading.
          <StatCard
            label="Allocation / expected"
            value={`${(agg.totalFreeAllocation ?? 0).toLocaleString()} / ${(agg.totalExpected ?? 0).toLocaleString()}`}
            unit="cr"
            tone={(agg.totalFreeAllocation ?? 0) < (agg.totalExpected ?? 0) ? 'bad' : 'default'}
            hint={
              (agg.totalFreeAllocation ?? 0) < (agg.totalExpected ?? 0)
                ? 'class is short — must cut or trade'
                : 'class is covered'
            }
            icon={<Landmark size={12} />}
          />
        )}
        {agg.reservePot > 0 && (
          // The cost containment reserve only appears once it has something to give — a
          // year that opened with no shortfall has no pot, and showing an empty one would
          // just be noise on a projector.
          <StatCard
            label="Price reserve"
            value={`${agg.reserveReleased.toLocaleString()} / ${agg.reservePot.toLocaleString()}`}
            unit="cr"
            tone={agg.reserveReleased > 0 ? 'good' : 'default'}
            hint={
              agg.reserveReleased > 0
                ? 'released — the market reached a trigger price'
                : 'held back; releases in steps as the price rises'
            }
            icon={<Landmark size={12} />}
          />
        )}
        <StatCard
          label={agg.totalRealized !== null ? 'Class realized' : 'Class expected'}
          value={agg.totalRealized ?? agg.totalExpected ?? '—'}
          unit={agg.totalRealized !== null || agg.totalExpected !== null ? 'tCO₂' : undefined}
          tone={
            agg.totalRealized !== null && agg.totalFreeAllocation !== null
              ? agg.totalRealized > agg.totalFreeAllocation
                ? 'bad'
                : 'good'
              : 'default'
          }
          hint={agg.totalRealized === null ? 'mean — realized at year end' : undefined}
        />
        <StatCard
          label="Cost this year"
          value={agg.totalCostThisYear ?? '—'}
          tone={agg.totalCostThisYear ? 'bad' : 'default'}
          hint={agg.totalCostThisYear !== null ? 'purchases + penalties' : 'after market close'}
        />
      </div>

      {/* Live market (trade phase) */}
      {snap.phase === 'trade' && snap.market && (
        <>
          <MarketTicker market={snap.market} />
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
            <div className="rounded-xl border border-border bg-card/70 p-5">
              <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
                Live order book
              </div>
              <OrderBook market={snap.market} anonymous={false} />
            </div>
            <div className="rounded-xl border border-border bg-card/70 p-5">
              <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
                Live trades
              </div>
              <div className="max-h-[60vh] overflow-y-auto">
                <TradesFeed trades={snap.market.trades} anonymous={false} max={40} />
              </div>
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
              Leaderboard — closest to your own optimum wins (skill, size-neutral) · click a row for history
            </div>
            <LeaderboardTable rows={snap.leaderboard} onRowClick={setHistoryId} />
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
                  <th className="py-2 pr-3 font-normal text-right">Auction</th>
                  <th className="py-2 pr-3 font-normal text-right">Banked</th>
                  <th className="py-2 pr-3 font-normal text-right">Traded</th>
                  <th className="py-2 pr-3 font-normal text-right">Held</th>
                  <th className="py-2 pr-3 font-normal text-right">Expected</th>
                  <th className="py-2 pr-3 font-normal text-right">Realized</th>
                  <th className="py-2 pr-3 font-normal text-right">Net</th>
                  <th className="py-2 font-normal text-right">Cost Σ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {snap.players.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2 pr-3 font-mono">
                      <span className="inline-flex items-center gap-2">
                        {p.isBot ? (
                          <Bot size={12} className="text-accent shrink-0" />
                        ) : (
                          <ConnectionDot connected={p.connected} />
                        )}
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
                      {p.regulatorGranted?.toLocaleString() ?? '—'}
                    </td>
                    <td
                      className={cn(
                        'py-2 pr-3 font-mono text-right',
                        p.banked !== null && p.banked > 0 && 'text-primary',
                        p.banked !== null && p.banked < 0 && 'text-destructive',
                        (p.banked === null || p.banked === 0) && 'text-muted-foreground',
                      )}
                    >
                      {p.banked
                        ? `${p.banked > 0 ? '+' : ''}${p.banked.toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-right">
                      {p.traded !== null
                        ? `${p.traded > 0 ? '+' : ''}${p.traded.toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-right">
                      {p.creditsHeld?.toLocaleString() ?? '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-right text-muted-foreground">
                      {p.expectedEmission.toLocaleString()}
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
                      {p.score.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PlayerHistoryDialog snap={snap} playerId={historyId} onClose={() => setHistoryId(null)} />
    </div>
  )
}

import { Bot, Play, Plus, Users, X } from 'lucide-react'
import { useState } from 'react'
import type { BotType, HostSnapshot } from '@shared/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../components/ui/alert-dialog'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { ConnectionDot, IndustryBadge, WarningBanner } from '../../components/game/cards'
import { BOT_LABELS, MODE_LABELS } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'
import { ModePicker, SettingsPanel } from './HostControls'

const BOT_TYPES: BotType[] = ['compliance', 'marketMaker', 'speculator', 'noise']

export function HostLobbyScreen({ snap }: { snap: HostSnapshot }) {
  const { hostAction } = useGame()
  const [busy, setBusy] = useState(false)
  const [botType, setBotType] = useState<BotType>('compliance')
  const [botCount, setBotCount] = useState('3')
  const mode = snap.capMode ? MODE_LABELS[snap.capMode] : null
  const joinUrl = `${window.location.origin}/`
  // Previewed in the lobby, before the engine has issued anything. Pure-trader bots
  // are excluded, matching the benchmarking mechanism.
  const emitters = snap.players.filter(
    (p) => !(p.isBot && (p.botType === 'marketMaker' || p.botType === 'speculator')),
  )
  const benchmarkTotal = emitters.reduce(
    (sum, p) => sum + (snap.config.benchmark[p.industry] ?? 0),
    0,
  )
  // Hybrid preview, mirroring shared/engine/hybrid.ts at the opening year (no cap reduction
  // applies to round one, so the factor is 1 and can be left out here).
  const hybridFreeTotal = emitters.reduce(
    (sum, p) =>
      sum + (snap.config.benchmark[p.industry] ?? 0) * (snap.config.hybridFreeShare[p.industry] ?? 0),
    0,
  )
  const hybridCap = snap.classAggregate.totalBaselineEmissions * snap.config.auctionCapRatio
  const hybridPool = Math.max(0, hybridCap - hybridFreeTotal)

  const addBots = () => {
    const count = Math.max(1, Math.min(20, Math.floor(Number(botCount) || 1)))
    void hostAction('host:addBots', { botType, count })
  }

  const start = async () => {
    setBusy(true)
    await hostAction('host:startYear')
    setBusy(false)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
      <div className="flex flex-col gap-5">
        {/* Projectable join panel */}
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-8 text-center">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-3">
            Join at <span className="text-foreground">{joinUrl}</span> with code
          </div>
          <div
            className="text-7xl font-black tracking-[0.2em] text-primary"
            style={{ fontFamily: "'Unbounded', sans-serif" }}
          >
            {snap.roomCode}
          </div>
          <div className="flex items-center justify-center gap-2 mt-4 text-sm font-mono text-muted-foreground">
            <Users size={14} className="text-primary" />
            {snap.players.length} compan{snap.players.length === 1 ? 'y' : 'ies'} registered
          </div>
        </div>

        {/* Roster */}
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            Roster
          </div>
          {snap.players.length === 0 ? (
            <p className="text-sm text-muted-foreground font-mono animate-pulse">
              Waiting for students to join…
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {snap.players.map((p) => (
                <div key={p.id} className="flex items-center gap-3 py-2">
                  {p.isBot ? (
                    <Bot size={13} className="text-accent shrink-0" />
                  ) : (
                    <ConnectionDot connected={p.connected} />
                  )}
                  <span className="font-mono font-bold text-sm text-foreground w-9">{p.id}</span>
                  <span className="text-sm text-foreground flex-1 truncate">{p.name}</span>
                  {p.isBot && p.botType ? (
                    <span className="text-[10px] font-mono uppercase tracking-wider text-accent border border-accent/40 rounded-full px-2 py-0.5">
                      {BOT_LABELS[p.botType]}
                    </span>
                  ) : (
                    <IndustryBadge industry={p.industry} size="sm" />
                  )}
                  <span className="text-xs font-mono text-muted-foreground w-20 text-right">
                    {p.isBot ? '—' : `${p.baselineEmission.toLocaleString()} tCO₂`}
                  </span>
                  <button
                    onClick={() =>
                      void hostAction(p.isBot ? 'host:removeBot' : 'host:kickPlayer', {
                        playerId: p.id,
                      })
                    }
                    className="text-muted-foreground hover:text-destructive transition-colors"
                    title={`Remove ${p.name}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {/* Mode picker */}
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            Cap mechanism
          </div>
          <ModePicker capMode={snap.capMode} />
        </div>

        {/* Game settings */}
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
            Game settings
          </div>
          <SettingsPanel config={snap.config} />
        </div>

        {/* Add bots */}
        {snap.capMode !== null && (
          <div className="rounded-xl border border-accent/30 bg-accent/5 p-5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
              <Bot size={12} className="text-accent" />
              Add market bots
            </div>
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-[10px] font-mono uppercase text-muted-foreground">Type</label>
                <select
                  value={botType}
                  onChange={(e) => setBotType(e.target.value as BotType)}
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm font-mono"
                >
                  {BOT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {BOT_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1 w-16">
                <label className="text-[10px] font-mono uppercase text-muted-foreground">Count</label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={botCount}
                  onChange={(e) => setBotCount(e.target.value)}
                  className="font-mono"
                />
              </div>
              <Button variant="outline" onClick={addBots} className="font-bold">
                <Plus size={14} /> Add
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground font-mono mt-2">
              Bots trade in the order book, and bid in the auction where there is one. Compliance
              anchors price to fundamentals; market makers add liquidity; speculators &amp; noise add
              realism. About five is the sweet spot — two market makers already keep the book
              two-sided, and more past that buys very little.
              {snap.capMode === 'benchmarking' && (
                <>
                  {' '}
                  Compliance &amp; noise bots are real emitters and receive their sector benchmark;
                  market makers &amp; speculators get none and buy an opening book instead.
                </>
              )}
            </p>
          </div>
        )}

        {/* Class baseline */}
        <div className="rounded-xl border border-border bg-card/70 p-5">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">
            Class baseline (Σ Year 10)
          </div>
          <div className="text-2xl font-bold font-mono text-foreground">
            {snap.classAggregate.totalBaselineEmissions.toLocaleString()}
            <span className="text-sm text-muted-foreground ml-1">tCO₂</span>
          </div>
          {snap.capMode === 'grandfathering' && (
            // Read from the ratio actually in force, not the 0.8 this used to hardcode:
            // grandfathering has opened at the full class baseline since the phase A+B
            // calibration, so the panel was quoting a limit 20% below the one it would issue.
            <div className="text-xs text-muted-foreground mt-1 font-mono">
              → free credit limit ={' '}
              {(
                Math.round(
                  snap.classAggregate.totalBaselineEmissions * snap.config.freeCreditRatio * 10,
                ) / 10
              ).toLocaleString()}{' '}
              ({Math.round(snap.config.freeCreditRatio * 100)}%)
            </div>
          )}
          {snap.capMode === 'auctioning' && (
            <div className="text-xs text-muted-foreground mt-1 font-mono">
              → no free credits; ={' '}
              {(
                Math.round(
                  snap.classAggregate.totalBaselineEmissions * snap.config.auctionCapRatio * 10,
                ) / 10
              ).toLocaleString()}{' '}
              ({Math.round(snap.config.auctionCapRatio * 100)}%) goes to the sealed-bid auction
            </div>
          )}
          {snap.capMode === 'benchmarking' && (
            <div className="text-xs text-muted-foreground mt-1 font-mono">
              → free credits = {(Math.round(benchmarkTotal * 10) / 10).toLocaleString()} from
              per-sector benchmarks, tightened every year (see settings)
            </div>
          )}
          {snap.capMode === 'hybrid' && (
            <div className="text-xs text-muted-foreground mt-1 font-mono">
              → cap = {(Math.round(hybridCap * 10) / 10).toLocaleString()} ·{' '}
              {(Math.round(hybridFreeTotal * 10) / 10).toLocaleString()} issued free ·{' '}
              <span className={hybridPool > 0 ? 'text-accent' : 'text-destructive'}>
                {(Math.round(hybridPool * 10) / 10).toLocaleString()} auctioned
              </span>
              {hybridPool <= 0 && (
                // Not a hard error — the year still plays — but the auction the mode exists
                // for would never open, so it must not be discovered mid-class.
                <div className="text-destructive mt-1">
                  The free shares use up the whole cap: nothing would be auctioned and this
                  plays as pure benchmarking. Lower the shares or raise the auction supply
                  ratio in settings.
                </div>
              )}
            </div>
          )}
        </div>

        {mode && !mode.implemented && (
          <WarningBanner>
            {mode.label} allocation is pending from the game designer — the game can only
            start under Grandfathering for now.
          </WarningBanner>
        )}

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              disabled={busy || snap.players.length === 0}
              className="h-12 font-bold w-full"
            >
              <Play size={16} /> Start Year 11
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Start Year 11?</AlertDialogTitle>
              <AlertDialogDescription>
                Registration closes and the roster locks — free credits are allocated from
                the {snap.players.length} registered compan
                {snap.players.length === 1 ? 'y' : 'ies'}. Late students will not be able
                to join.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void start()}>
                Lock roster &amp; start
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}

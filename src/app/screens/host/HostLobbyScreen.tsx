import { Play, Users, X } from 'lucide-react'
import { useState } from 'react'
import type { HostSnapshot } from '@shared/types'
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
import { ConnectionDot, IndustryBadge, WarningBanner } from '../../components/game/cards'
import { MODE_LABELS } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'
import { ModePicker, SettingsPanel } from './HostControls'

export function HostLobbyScreen({ snap }: { snap: HostSnapshot }) {
  const { hostAction } = useGame()
  const [busy, setBusy] = useState(false)
  const mode = snap.capMode ? MODE_LABELS[snap.capMode] : null
  const joinUrl = `${window.location.origin}/`

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
                  <ConnectionDot connected={p.connected} />
                  <span className="font-mono font-bold text-sm text-foreground w-9">{p.id}</span>
                  <span className="text-sm text-foreground flex-1 truncate">{p.name}</span>
                  <IndustryBadge industry={p.industry} size="sm" />
                  <span className="text-xs font-mono text-muted-foreground w-20 text-right">
                    {p.baselineEmission.toLocaleString()} tCO₂
                  </span>
                  <button
                    onClick={() => void hostAction('host:kickPlayer', { playerId: p.id })}
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
            <div className="text-xs text-muted-foreground mt-1 font-mono">
              → free credit limit ={' '}
              {(Math.round(snap.classAggregate.totalBaselineEmissions * 0.8 * 10) / 10).toLocaleString()}{' '}
              (80%)
            </div>
          )}
          {snap.capMode === 'auctioning' && (
            <div className="text-xs text-muted-foreground mt-1 font-mono">
              → no free credits; the full baseline is sold at the fixed price
            </div>
          )}
          {snap.capMode === 'benchmarking' && (
            <div className="text-xs text-muted-foreground mt-1 font-mono">
              → free credits come from per-industry benchmarks (see settings)
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

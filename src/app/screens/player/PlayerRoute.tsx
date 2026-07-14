import { LogOut, WifiOff } from 'lucide-react'
import { useGame } from '../../net/GameContext'
import { PhaseBadge } from '../../components/game/cards'
import { EcoDots, GameTitle } from '../../components/game/theme'
import { CapStageScreen } from './CapStageScreen'
import { EmissionsRevealScreen } from './EmissionsRevealScreen'
import { JoinScreen } from './JoinScreen'
import { LobbyScreen } from './LobbyScreen'
import { TradeStageScreen } from './TradeStageScreen'
import { YearSummaryScreen } from './YearSummaryScreen'

export function PlayerRoute() {
  const { playerSnapshot, resuming, connected, leave } = useGame()

  if (!playerSnapshot) {
    if (resuming) {
      return (
        <CenteredShell>
          <p className="text-muted-foreground text-sm font-mono animate-pulse">
            Reconnecting to your session…
          </p>
        </CenteredShell>
      )
    }
    return <JoinScreen />
  }

  const snap = playerSnapshot
  const body = (() => {
    switch (snap.phase) {
      case 'lobby':
        return <LobbyScreen snap={snap} />
      case 'cap':
        return <CapStageScreen snap={snap} />
      case 'reveal':
        return <EmissionsRevealScreen snap={snap} />
      case 'trade':
        return <TradeStageScreen snap={snap} />
      case 'yearSummary':
      case 'ended':
        return <YearSummaryScreen snap={snap} />
    }
  })()

  return (
    <div className="relative min-h-screen bg-background overflow-x-hidden">
      <EcoDots />
      <div className="relative z-10 max-w-3xl mx-auto px-4 pb-16">
        <header className="flex flex-wrap items-center justify-between gap-3 py-5">
          <div className="flex items-center gap-3">
            <GameTitle small />
            <span className="text-xs font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
              {snap.roomCode}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {!connected && (
              <span className="flex items-center gap-1 text-xs font-mono text-destructive">
                <WifiOff size={12} /> reconnecting…
              </span>
            )}
            <PhaseBadge phase={snap.phase} year={snap.currentYear} />
            <button
              onClick={leave}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors font-mono"
              title="Leave session"
            >
              <LogOut size={12} />
            </button>
          </div>
        </header>
        {body}
      </div>
    </div>
  )
}

export function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center overflow-hidden">
      <EcoDots />
      <div className="relative z-10 w-full max-w-md px-6">{children}</div>
    </div>
  )
}

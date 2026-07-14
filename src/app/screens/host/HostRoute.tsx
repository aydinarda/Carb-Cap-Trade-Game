import { LogOut, WifiOff } from 'lucide-react'
import { useGame } from '../../net/GameContext'
import { PhaseBadge } from '../../components/game/cards'
import { EcoDots, GameTitle } from '../../components/game/theme'
import { CenteredShell } from '../player/PlayerRoute'
import { HostCreateScreen } from './HostCreateScreen'
import { HostGameScreen } from './HostGameScreen'
import { HostLobbyScreen } from './HostLobbyScreen'

export function HostRoute() {
  const { hostSnapshot, resuming, connected, leave } = useGame()

  if (!hostSnapshot) {
    if (resuming) {
      return (
        <CenteredShell>
          <p className="text-muted-foreground text-sm font-mono animate-pulse text-center">
            Reconnecting to your session…
          </p>
        </CenteredShell>
      )
    }
    return <HostCreateScreen />
  }

  const snap = hostSnapshot
  return (
    <div className="relative min-h-screen bg-background overflow-x-hidden">
      <EcoDots />
      <div className="relative z-10 max-w-6xl mx-auto px-4 pb-16">
        <header className="flex flex-wrap items-center justify-between gap-3 py-5">
          <div className="flex items-center gap-3">
            <GameTitle small />
            <span className="text-xs font-mono uppercase tracking-widest text-accent border border-accent/30 rounded px-1.5 py-0.5">
              Instructor
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
        {snap.phase === 'lobby' ? <HostLobbyScreen snap={snap} /> : <HostGameScreen snap={snap} />}
      </div>
    </div>
  )
}

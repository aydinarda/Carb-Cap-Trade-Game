import { Eye, LogOut, ScanSearch, ShieldAlert, ShieldCheck, User, WifiOff } from 'lucide-react'
import type { PlayerSnapshot } from '@shared/types'
import { useGame } from '../../net/GameContext'
import { AnnouncementsPanel, PhaseBadge } from '../../components/game/cards'
import { cn, EcoDots, GameTitle } from '../../components/game/theme'
import { CapStageScreen } from './CapStageScreen'
import { EmissionsRevealScreen } from './EmissionsRevealScreen'
import { JoinScreen } from './JoinScreen'
import { LobbyScreen } from './LobbyScreen'
import { TradeStageScreen } from './TradeStageScreen'
import { YearSummaryScreen } from './YearSummaryScreen'

export function PlayerRoute() {
  const { playerSnapshot, resuming, connected, leave, watching } = useGame()

  if (!playerSnapshot && watching) {
    // Never the join screen here: joining would overwrite the host identity this page uses.
    return (
      <CenteredShell>
        <p className="text-muted-foreground text-sm font-mono animate-pulse">
          Connecting to {watching}… — open this page from the host screen of a running game.
        </p>
      </CenteredShell>
    )
  }

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
      {/*
        The trade stage is a three-column terminal — an order ticket beside a book beside the
        abatement panel — and does not fit the reading measure the other screens want. The
        rest stay narrow: a cap-stage panel or a year summary is prose and a few figures, and
        stretching those to 1600px makes them harder to read, not easier.
      */}
      <div
        className={cn(
          'relative z-10 mx-auto px-4 pb-16',
          snap.phase === 'trade' ? 'max-w-[1600px]' : 'max-w-3xl',
        )}
      >
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
            {/* Compliance, while it is still actionable. Deliberately NOT shown outside the
                trade stage: before the market opens there is nothing to do about it, and
                after settlement the year summary reports what actually happened — a badge
                still saying "compliant" beside a settled shortfall would be a lie. */}
            {snap.phase === 'trade' && <ComplianceBadge snap={snap} />}
            <span className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
              <User size={12} />
              {snap.you.name}
            </span>
            {watching ? (
              <span className="flex items-center gap-1.5 text-xs font-mono text-accent border border-accent/40 bg-accent/10 rounded-full px-2 py-0.5">
                <Eye size={12} /> watching — read only
              </span>
            ) : (
              <button
                onClick={leave}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors font-mono"
                title="Leave session"
              >
                <LogOut size={12} />
              </button>
            )}
          </div>
        </header>
        {/* Above the body, in every phase. A subsidy starting in two rounds changes what a
            company should bid at the auction, and the cap stage does not render the
            abatement card these used to live inside. */}
        {snap.you.screening && <ScreeningBanner notice={snap.you.screening} />}
        <AnnouncementsPanel snap={snap} />
        {body}
      </div>
    </div>
  )
}

/**
 * Whether this company is currently covered, at a glance.
 *
 * Reads the same two numbers the trade screen's headline card does — what has to be covered
 * this year, and what is held — so the badge and the card can never disagree. Rounded to one
 * decimal before the comparison for the same reason: an unrounded 0.04 tonne residue would
 * flip the badge to "short" while the card, which rounds, shows 0.
 */
function ComplianceBadge({ snap }: { snap: PlayerSnapshot }) {
  const gap = Math.round(((snap.you.plannedEmission ?? 0) - (snap.you.creditsHeld ?? 0)) * 10) / 10
  const short = gap > 0
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-xs font-mono rounded-full border px-2 py-0.5',
        short
          ? 'text-destructive border-destructive/40 bg-destructive/10'
          : 'text-primary border-primary/40 bg-primary/10',
      )}
    >
      {short ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}
      {short ? `Short ${gap}` : 'Compliant'}
    </span>
  )
}

/**
 * "You are under screening": the regulator's market-cornering screen flagged this company. It
 * says why, and what the instructor may do about it — nothing happens automatically.
 */
function ScreeningBanner({ notice }: { notice: NonNullable<PlayerSnapshot['you']['screening']> }) {
  return (
    <div className="mb-4 rounded-xl border border-accent/50 bg-accent/10 p-4 flex gap-3">
      <ScanSearch size={18} className="text-accent shrink-0 mt-0.5" />
      <div className="flex flex-col gap-1 text-sm">
        <strong className="text-accent">You are under screening</strong>
        <span className="text-muted-foreground">The regulator is reviewing your trading for cornering the market:</span>
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {notice.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <span className="text-xs text-muted-foreground">
          The instructor may take back what you hold above {notice.keepMultiple}× your planned emission and
          sell it to the market at a fair price.
          {notice.penalized > 0 && <> {notice.penalized.toLocaleString()} t has been taken back so far.</>}
        </span>
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

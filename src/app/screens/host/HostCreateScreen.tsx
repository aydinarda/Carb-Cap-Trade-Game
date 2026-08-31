import { ArrowRight, Check } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import type { CapMode } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  FieldLabel,
  LandingCard,
  LandingHero,
  LandingNav,
  LandingShell,
} from '../../components/game/landing'
import { cn, MODE_LABELS } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

const MODES = Object.keys(MODE_LABELS) as CapMode[]

/**
 * What each mode is actually FOR, in the instructor's terms.
 *
 * `MODE_LABELS[m].desc` explains the mechanism and is what a student reads in-game. This is
 * the other question — which one to run with this class today — and it is not answerable
 * from the mechanism alone. Kept here rather than in the shared theme file because it is
 * the only screen where the choice is being made.
 */
const MODE_TEACHING: Record<CapMode, { headline: string; note: string }> = {
  grandfathering: {
    headline: 'Start here with a new class',
    note: 'The gentlest opening: everyone gets credits in proportion to what they already emit, so nobody is short on day one and the mechanics can be learned before the pressure arrives.',
  },
  benchmarking: {
    headline: 'The fairness argument',
    note: 'One benchmark per sector, opening near the sector average and cut every year, so an average emitter runs short as the game goes on and an efficient one stays long. This is where a class starts arguing about who should have to pay.',
  },
  auctioning: {
    headline: 'The full market',
    note: 'No free credits at all — every allowance is bought at a sealed-bid auction before the market opens. The most demanding of the three, and the closest to where the EU ETS has ended up.',
  },
  hybrid: {
    headline: 'What the EU actually does',
    note: 'Both at once: you choose which sectors keep a share of their benchmark for free, and the rest of the cap is auctioned. Because free credits come OUT of the auction supply rather than on top of it, the class can see who pays for an exemption — the argument that runs through every real allocation decision. Set the shares per sector in the lobby.',
  },
}

export function HostCreateScreen() {
  const { createSession, connected } = useGame()
  const [hostKey, setHostKey] = useState('')
  const [mode, setMode] = useState<CapMode>('grandfathering')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      await createSession(hostKey, mode)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <LandingShell>
      <LandingNav cta={{ label: 'Play as a company', to: '/' }} />

      <LandingHero
        lead="Run the session."
        accent="Pick the rules."
        subtitle="Choose how allowances are handed out, open the room, and drive the class through the years. You can add bots for liquidity and change the settings between rounds."
      />

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <LandingCard>
          <div className="flex flex-col gap-3">
            <FieldLabel>Choose the allocation rule</FieldLabel>
            {/* Stacked, not a grid: each option carries a paragraph the instructor is
                actually meant to read before choosing, and three columns of prose at this
                width is three columns nobody reads. */}
            <div className="flex flex-col gap-3">
              {MODES.map((m) => {
                const meta = MODE_LABELS[m]
                const teaching = MODE_TEACHING[m]
                const selected = mode === m
                return (
                  <button
                    type="button"
                    key={m}
                    onClick={() => setMode(m)}
                    aria-pressed={selected}
                    className={cn(
                      'text-left rounded-xl border p-4 transition-colors',
                      selected
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-surface-alt/40 hover:border-primary/40',
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 font-bold text-foreground">
                        <span
                          className={cn(
                            'size-4 rounded-full border flex items-center justify-center shrink-0',
                            selected ? 'border-primary bg-primary' : 'border-border',
                          )}
                        >
                          {selected && <Check size={11} className="text-primary-foreground" />}
                        </span>
                        {meta.label}
                      </span>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                        {teaching.headline}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                      {teaching.note}
                    </p>
                    {!meta.implemented && (
                      <span className="inline-block mt-2 text-[10px] font-mono uppercase tracking-wider text-accent border border-accent/40 rounded-full px-2 py-0.5">
                        allocation pending
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel>Host key</FieldLabel>
            <Input
              type="password"
              value={hostKey}
              onChange={(e) => setHostKey(e.target.value)}
              placeholder="The key your deployment was configured with"
              className="h-12"
              autoComplete="current-password"
            />
            {/* Says why the field exists rather than leaving it as an unexplained gate —
                the usual reason someone is stuck here is that they are a student who
                followed the Instructor link by mistake. */}
            <p className="text-xs text-muted-foreground">
              Creating a room is restricted so a class cannot spawn sessions.{' '}
              <Link to="/" className="text-primary hover:underline">
                Joining one instead?
              </Link>
            </p>
          </div>

          <Button
            type="submit"
            disabled={busy || !connected || !hostKey}
            className="h-12 font-bold gap-2"
          >
            {busy ? 'Creating…' : 'Create session'}
            {!busy && <ArrowRight size={18} />}
          </Button>

          {!connected && (
            <p className="text-xs text-muted-foreground font-mono text-center">
              connecting to server…
            </p>
          )}
        </LandingCard>
      </form>
    </LandingShell>
  )
}

import { ArrowRight } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { INDUSTRIES, INDUSTRY_NAMES, type Industry } from '@shared/constants'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  FieldLabel,
  LandingCard,
  LandingFeatures,
  LandingHero,
  LandingNav,
  LandingShell,
} from '../../components/game/landing'
import { cn, INDUSTRY_META } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

/** The one-line size class, and the sectors behind it. */
const INDUSTRY_BLURBS: Record<Industry, { size: string; detail: string }> = {
  'Power & Utilities': { size: 'Very high emitter', detail: 'grids and generation' },
  'Heavy Materials': { size: 'High emitter', detail: 'steel, cement, mining' },
  'Manufacturing & Chemicals': { size: 'Medium emitter', detail: 'factories and process industry' },
  Transport: { size: 'Low emitter', detail: 'logistics and mobility' },
}

export function JoinScreen() {
  const { joinAsPlayer, connected } = useGame()
  const [roomCode, setRoomCode] = useState('')
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState<Industry | null>(null)
  const [busy, setBusy] = useState(false)

  const ready = connected && roomCode.trim().length === 4 && !!name.trim() && !!industry

  const join = async () => {
    if (!industry) return
    setBusy(true)
    try {
      await joinAsPlayer(roomCode, name, industry)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <LandingShell>
      <LandingNav cta={{ label: 'Instructor', to: '/host' }} />

      <LandingHero
        lead="Run your company."
        accent="Trade smart. Cut emissions."
        subtitle="Manage your emissions, trade allowances in the market, and stay under the cap at the lowest cost you can manage."
      />

      <LandingFeatures />

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void join()
        }}
      >
        <LandingCard>
          <div className="flex flex-col gap-3">
            <FieldLabel>Pick your industry</FieldLabel>
            {/* Four tiles rather than a select: the choice decides how much this company
                emits and therefore how the whole game feels, so it deserves to be the
                largest thing on the form rather than a collapsed dropdown. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {INDUSTRY_NAMES.map((ind) => {
                const meta = INDUSTRY_META[ind]
                const range = INDUSTRIES[ind]
                const blurb = INDUSTRY_BLURBS[ind]
                const selected = industry === ind
                return (
                  <button
                    type="button"
                    key={ind}
                    onClick={() => setIndustry(ind)}
                    aria-pressed={selected}
                    className={cn(
                      'rounded-xl border p-4 text-center transition-colors flex flex-col items-center gap-2',
                      selected
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-surface-alt/40 hover:border-primary/40',
                    )}
                  >
                    {/* Sector colour plus an icon plus the name — never colour alone, so the
                        tiles stay distinguishable to a colour-blind player and on a
                        washed-out projector. */}
                    <span style={{ color: meta.color }} className="[&>svg]:size-7">
                      {meta.icon}
                    </span>
                    {/* Fixed height for the name: "Manufacturing & Chemicals" wraps to two
                        lines and the other three do not, which pushed that tile's size class
                        and range out of alignment with its neighbours. */}
                    <span className="font-bold text-sm text-foreground leading-tight min-h-[2.5rem] flex items-center">
                      {ind}
                    </span>
                    <span className="text-xs text-muted-foreground leading-tight">
                      {blurb.size}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/60 leading-tight">
                      ~{range.low}–{range.high} tCO₂/yr
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              {/* Required, not optional. There is no "join any open room" on the server —
                  a code identifies the room your instructor is running, and without one
                  there is nothing to join. The way in without a code is to create a
                  session, which is the link under the button. */}
              <FieldLabel>Room code</FieldLabel>
              <Input
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="e.g. 7KQ2"
                maxLength={4}
                className="h-12 font-mono text-lg tracking-[0.35em] uppercase"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-2">
              <FieldLabel>Your name</FieldLabel>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your company name"
                maxLength={40}
                className="h-12"
              />
            </div>
          </div>

          <Button type="submit" disabled={busy || !ready} className="h-12 font-bold gap-2">
            {busy ? 'Joining…' : 'Join game'}
            {!busy && <ArrowRight size={18} />}
          </Button>

          <div className="text-center">
            {!connected ? (
              <p className="text-xs text-muted-foreground font-mono">connecting to server…</p>
            ) : (
              <Link
                to="/host"
                className="text-sm text-muted-foreground hover:text-primary transition-colors"
              >
                or create a new session
              </Link>
            )}
          </div>
        </LandingCard>
      </form>
    </LandingShell>
  )
}

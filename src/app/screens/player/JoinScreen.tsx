import { ArrowRightLeft, Leaf } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { INDUSTRIES, INDUSTRY_NAMES, type Industry } from '@shared/constants'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { cn, GameTitle, INDUSTRY_META } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'
import { CenteredShell } from './PlayerRoute'

const INDUSTRY_BLURBS: Record<Industry, string> = {
  'Power & Utilities': 'Very high emitter — big allocation, big exposure',
  'Heavy Materials': 'High emitter — steel, cement, mining',
  'Manufacturing & Chemicals': 'Medium emitter — factories and process industry',
  Transport: 'Low emitter — logistics and mobility',
}

export function JoinScreen() {
  const { joinAsPlayer, connected } = useGame()
  const [roomCode, setRoomCode] = useState('')
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState<Industry | null>(null)
  const [busy, setBusy] = useState(false)

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
    <CenteredShell>
      <div className="flex flex-col items-center text-center mb-6">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/30 flex items-center justify-center relative mb-5">
          <Leaf size={30} className="text-primary" />
          <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-accent flex items-center justify-center">
            <ArrowRightLeft size={9} className="text-accent-foreground" />
          </div>
        </div>
        <GameTitle />
        <p
          className="text-muted-foreground text-sm mt-3 max-w-xs"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          You run a company. Pick your industry, get your emission allowance, and cover
          the gap in the market.
        </p>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void join()
        }}
      >
        <Input
          value={roomCode}
          onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
          placeholder="Room code (e.g. 7KQ2)"
          maxLength={4}
          className="text-center font-mono text-lg tracking-[0.4em] uppercase h-12"
          autoFocus
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={40}
          className="h-12"
        />

        <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mt-1">
          Pick your industry
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {INDUSTRY_NAMES.map((ind) => {
            const meta = INDUSTRY_META[ind]
            const range = INDUSTRIES[ind]
            const selected = industry === ind
            return (
              <button
                type="button"
                key={ind}
                onClick={() => setIndustry(ind)}
                className={cn(
                  'text-left rounded-xl border p-3 transition-colors',
                  selected
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border bg-card/60 hover:border-primary/30',
                )}
              >
                <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <span style={{ color: meta.color }}>{meta.icon}</span>
                  {ind}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">{INDUSTRY_BLURBS[ind]}</p>
                <p className="text-[10px] font-mono text-muted-foreground/70 mt-0.5">
                  ~{range.low}–{range.high} tCO₂/yr
                </p>
              </button>
            )
          })}
        </div>

        <Button
          type="submit"
          disabled={busy || !connected || roomCode.trim().length < 4 || !name.trim() || !industry}
          className="h-12 font-bold"
        >
          {busy ? 'Joining…' : 'Join the game'}
        </Button>
        {!connected && (
          <p className="text-xs text-muted-foreground text-center font-mono">
            connecting to server…
          </p>
        )}
      </form>
    </CenteredShell>
  )
}

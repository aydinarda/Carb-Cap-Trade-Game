import { Shield } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { CapMode } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { cn, GameTitle, MODE_LABELS } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'
import { CenteredShell } from '../player/PlayerRoute'

const MODES = Object.keys(MODE_LABELS) as CapMode[]

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
    <CenteredShell>
      <div className="flex flex-col items-center text-center mb-8">
        <div className="w-14 h-14 rounded-2xl bg-accent/10 border border-accent/30 flex items-center justify-center mb-4">
          <Shield size={26} className="text-accent" />
        </div>
        <GameTitle />
        <p className="text-muted-foreground text-sm mt-2 font-mono uppercase tracking-widest">
          Instructor panel
        </p>
      </div>

      <div className="flex flex-col gap-3 mb-5">
        {MODES.map((m) => {
          const meta = MODE_LABELS[m]
          return (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'text-left rounded-xl border p-4 transition-colors',
                mode === m
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border bg-card/60 hover:border-primary/30',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-sm text-foreground">{meta.label}</span>
                {!meta.implemented && (
                  <span className="text-[10px] font-mono uppercase tracking-wider text-accent border border-accent/40 rounded-full px-2 py-0.5">
                    allocation pending
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{meta.tagline}</p>
            </button>
          )
        })}
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <Input
          type="password"
          value={hostKey}
          onChange={(e) => setHostKey(e.target.value)}
          placeholder="Host key"
          className="h-12"
        />
        <Button
          type="submit"
          disabled={busy || !connected || !hostKey}
          className="h-12 font-bold"
        >
          {busy ? 'Creating…' : 'Create session'}
        </Button>
      </form>
    </CenteredShell>
  )
}

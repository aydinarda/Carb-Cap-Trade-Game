import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import type { ChatMessage, ReferendumProposal, ReferendumResult, ReferendumView } from '@shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Progress } from '../ui/progress'
import { cn } from './theme'

/**
 * The pieces the player's and the host's referendum panels share: the proposal in words, the
 * stage clock, the chat and the result.
 */

export const CHAT_MAX_CHARS = 280

/** The proposal as the class reads it. */
export function proposalText(p: ReferendumProposal, appliesFrom: number): string {
  const pct = Math.round(p.frac * 1000) / 10
  return `Cap borrowing at ${pct}% of each company's planned emission, from round ${appliesFrom}. A shortfall beyond the cap is fined that round.`
}

export function stageLabel(stage: ReferendumView['stage']): string {
  return stage === 'chat' ? 'Discussion' : stage === 'vote' ? 'Voting' : 'Result'
}

/**
 * The stage clock. The server sends the time left when it built the snapshot; the bar runs down
 * from there on this machine's clock, so it moves smoothly between snapshots and a slow network
 * costs at most the latency, never a frozen bar.
 */
export function StageClock({ view }: { view: ReferendumView }) {
  const total = (view.stage === 'chat' ? view.chatSeconds : view.voteSeconds) * 1000
  const [deadline, setDeadline] = useState(() => Date.now() + (view.remainingMs ?? 0))
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setDeadline(Date.now() + (view.remainingMs ?? 0))
  }, [view.id, view.stage, view.remainingMs])

  useEffect(() => {
    if (view.remainingMs === null) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [view.remainingMs])

  if (view.remainingMs === null || total <= 0) return null
  const left = Math.max(0, deadline - now)
  return (
    <div className="flex items-center gap-3">
      <Progress
        value={(left / total) * 100}
        className={cn('h-2', view.stage === 'vote' ? 'bg-destructive/20 [&>*]:bg-destructive' : '')}
      />
      <span className="text-xs font-mono tabular-nums text-muted-foreground w-10 text-right">
        {Math.ceil(left / 1000)}s
      </span>
    </div>
  )
}

export function ChatLog({ messages, empty }: { messages: ChatMessage[]; empty: string }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length])
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-background/60 px-3 py-2 flex flex-col gap-1.5">
      {messages.length === 0 && <p className="text-xs text-muted-foreground font-mono">{empty}</p>}
      {messages.map((m) => (
        <div key={m.id} className="text-sm leading-snug">
          <span className={cn('font-bold mr-1.5', m.from === 'host' ? 'text-accent' : 'text-foreground')}>{m.name}</span>
          <span className="text-foreground/90 break-words">{m.text}</span>
        </div>
      ))}
      <div ref={end} />
    </div>
  )
}

export function ChatInput({ onSend, disabled }: { onSend: (text: string) => Promise<boolean>; disabled?: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    const clean = text.trim()
    if (!clean) return
    setBusy(true)
    const ok = await onSend(clean)
    setBusy(false)
    if (ok) setText('')
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <Input
        value={text}
        maxLength={CHAT_MAX_CHARS}
        onChange={(e) => setText(e.target.value)}
        placeholder="Make your case…"
        disabled={disabled || busy}
      />
      <Button type="submit" disabled={disabled || busy || !text.trim()} className="gap-1.5">
        <Send size={14} /> Send
      </Button>
    </form>
  )
}

export function ResultLine({ result, appliesFrom }: { result: ReferendumResult; appliesFrom: number }) {
  const abstained = result.eligible - result.yes - result.no
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm font-mono',
        result.approved ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground',
      )}
    >
      <strong>{result.approved ? `PASSED — in force from round ${appliesFrom}` : 'REJECTED — borrowing stays as it was'}</strong>
      <div className="text-xs mt-0.5 text-muted-foreground">
        {result.yes} yes · {result.no} no · {abstained} did not vote
      </div>
    </div>
  )
}

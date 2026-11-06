import { useState } from 'react'
import { Vote } from 'lucide-react'
import type { PlayerSnapshot, VoteChoice } from '@shared/types'
import { Button } from '../../components/ui/button'
import { ChatInput, ChatLog, proposalText, ResultLine, stageLabel, StageClock } from '../../components/game/referendum'
import { cn } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

/**
 * The borrowing referendum, on a player's screen: the proposal, a minute of discussion, fifteen
 * seconds to vote with the bar running down, then the result. Shown while it runs and, once
 * closed, for the rest of the year summary it was held in.
 */
export function ReferendumPanel({ snap }: { snap: PlayerSnapshot }) {
  const { sendChat, vote } = useGame()
  const [busy, setBusy] = useState(false)
  const r = snap.referendum
  if (!r) return null
  const open = r.stage !== 'closed'
  if (!open && !(snap.phase === 'yearSummary' && r.year === snap.currentYear)) return null

  const cast = async (choice: VoteChoice) => {
    setBusy(true)
    await vote(choice)
    setBusy(false)
  }

  return (
    <div className={cn('mb-4 rounded-xl border p-4 flex flex-col gap-3', open ? 'border-accent/50 bg-accent/5' : 'border-border bg-card/60')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-accent">
          <Vote size={13} /> Referendum · {stageLabel(r.stage)}
        </div>
        {r.stage === 'chat' && <span className="text-[11px] font-mono text-muted-foreground">voting opens when the bar runs out</span>}
      </div>
      <p className="text-sm font-medium leading-snug">{proposalText(r.proposal, r.appliesFrom)}</p>
      {open && <StageClock view={r} />}

      <ChatLog messages={r.chat} empty={r.stage === 'chat' ? 'No messages yet — say how this would hit your company.' : 'Nobody spoke.'} />
      {r.stage === 'chat' && <ChatInput onSend={sendChat} />}

      {r.stage === 'vote' &&
        (r.canVote ? (
          <div className="flex items-center gap-2">
            <Button disabled={busy} onClick={() => void cast('yes')} variant={r.myVote === 'yes' ? 'default' : 'outline'} className="flex-1 font-bold">
              Yes
            </Button>
            <Button disabled={busy} onClick={() => void cast('no')} variant={r.myVote === 'no' ? 'destructive' : 'outline'} className="flex-1 font-bold">
              No
            </Button>
            <span className="text-[11px] font-mono text-muted-foreground w-36">
              {r.myVote ? `You voted ${r.myVote}. You can change it until the bar runs out.` : 'Not voted yet — no vote counts as abstaining.'}
            </span>
          </div>
        ) : (
          <p className="text-xs font-mono text-muted-foreground">Your company has no vote.</p>
        ))}

      {r.result && <ResultLine result={r.result} appliesFrom={r.appliesFrom} />}
    </div>
  )
}

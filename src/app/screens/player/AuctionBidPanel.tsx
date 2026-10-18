import { Check, Gavel, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { bidSteps, MAX_SWEEP_STEPS, type AuctionStep } from '@shared/engine/auction'
import type { PlayerSnapshot } from '@shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { FlowHint, StatCard } from '../../components/game/cards'
import { CAP_FLOW } from '../../components/game/theme'
import { useGame } from '../../net/GameContext'

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * What the company still has to buy: this year's emissions less everything it already
 * holds — free allocation and the carry banked from last year.
 *
 * Only the residual, not the whole expectation. Under a regime that issues free credits
 * AND runs an auction, defaulting the quantity to the full planned emission would have
 * every company bid for tonnes it has already been given. Under pure auctioning the free
 * allocation is zero, so this only adds the banked carry the default used to ignore.
 */
function residualNeed(snap: PlayerSnapshot): number {
  const held = (snap.you.freeAllocation ?? 0) + (snap.you.banked ?? 0)
  return Math.max(0, Math.round(snap.you.plannedEmission - held))
}

/** The steps on screen when the panel opens: the bid already in, else one step for the residual need. */
function initialSteps(snap: PlayerSnapshot): AuctionStep[] {
  const committed = snap.you.auctionBid
  if (committed) return bidSteps(committed).map((s) => ({ qty: s.qty, price: s.price }))
  return [{ qty: residualNeed(snap), price: r1(snap.prevMarketPrice ?? 10) }]
}

/**
 * The most a sweep can cost. Whatever the clearing price p turns out to be, the company wins
 * the steps priced at p or above and pays p for each credit — so the worst case is the largest
 * p × (quantity at or above p) over the step prices.
 */
function worstCase(steps: AuctionStep[]): { cost: number; at: number } {
  let best = { cost: 0, at: 0 }
  for (const s of steps) {
    const qty = steps.filter((o) => o.price >= s.price).reduce((a, o) => a + o.qty, 0)
    const cost = r1(qty * s.price)
    if (cost > best.cost) best = { cost, at: s.price }
  }
  return best
}

const describeSteps = (steps: AuctionStep[]) =>
  steps.map((s) => `${s.qty} cr at up to ${s.price}`).join(' · ')

/**
 * Cap-stage auction: submit a sealed bid — one step (quantity + max price), or a SWEEP of up
 * to MAX_SWEEP_STEPS steps added with "+". Each step is ranked like a separate bid; every
 * credit won is paid at the single clearing price.
 */
export function AuctionBidPanel({ snap }: { snap: PlayerSnapshot }) {
  const { submitBid, submitSweep } = useGame()
  const expected = snap.you.plannedEmission
  const committed = snap.you.auctionBid
  const cleared = snap.auctionPrice !== null

  const [steps, setSteps] = useState<AuctionStep[]>(() => initialSteps(snap))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSteps(initialSteps(snap))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.currentYear])

  const live = steps.filter((s) => s.qty > 0)
  const total = r1(live.reduce((a, s) => a + s.qty, 0))
  const worst = worstCase(live)

  const setStep = (i: number, patch: Partial<AuctionStep>) =>
    setSteps((all) => all.map((s, k) => (k === i ? { ...s, ...patch } : s)))
  // A new step defaults to the same quantity at a lower price: the next slice of a demand curve.
  const addStep = () =>
    setSteps((all) => {
      const last = all[all.length - 1] ?? { qty: residualNeed(snap), price: r1(snap.prevMarketPrice ?? 10) }
      return [...all, { qty: last.qty, price: r1(last.price * 0.8) }]
    })
  const removeStep = (i: number) => setSteps((all) => all.filter((_, k) => k !== i))

  const submit = async () => {
    if (live.length === 0) {
      toast.error('Enter a quantity above zero for at least one step.')
      return
    }
    setBusy(true)
    const ok = live.length === 1 ? await submitBid(live[0].qty, live[0].price) : await submitSweep(live)
    setBusy(false)
    if (ok) {
      toast.success(
        live.length === 1
          ? `Bid submitted: ${live[0].qty} credits at up to ${live[0].price} each`
          : `Sweep submitted: ${live.length} steps, ${total} credits in total`,
      )
    }
  }

  // After the auction clears, show the outcome.
  if (cleared) {
    const award = snap.you.auctionAward ?? 0
    const clearing = snap.auctionPrice ?? 0
    return (
      <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider mb-4">
          <Gavel size={12} className="text-accent" />
          Auction result — Year {snap.currentYear}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard label="Clearing price" value={clearing} tone="accent" hint="everyone pays this" />
          <StatCard label="You won" value={award} unit="cr" tone={award > 0 ? 'good' : 'bad'} />
          <StatCard label="Cost" value={r1(award * clearing)} tone="bad" hint={`${award} × ${clearing}`} />
        </div>
        {committed && bidSteps(committed).length === 1 && (
          <p className="text-[11px] text-muted-foreground font-mono mt-3">
            Your bid was {committed.qty} cr at up to {committed.price}.{' '}
            {committed.price >= clearing
              ? 'Won at the clearing price.'
              : 'Bid below clearing — not filled.'}
          </p>
        )}
        {committed && bidSteps(committed).length > 1 && (
          <div className="mt-3 flex flex-col gap-0.5">
            <p className="text-[11px] text-muted-foreground font-mono">Your sweep, step by step:</p>
            {bidSteps(committed).map((step, i) => (
              <p key={i} className="text-[11px] text-muted-foreground font-mono">
                {step.qty} cr at up to {step.price} —{' '}
                {step.price > clearing
                  ? 'filled at the clearing price'
                  : step.price === clearing
                    ? 'the marginal step: filled in part, pro-rata'
                    : 'below clearing — not filled'}
              </p>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-card/80 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-wider">
          <Gavel size={12} className="text-accent" />
          Auction — sealed bid, Year {snap.currentYear}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* What this company still has to BUY — it is what the quantity field defaults to,
              so without it on screen the default is a number out of nowhere. Where credits
              are already held the full expectation is shown too, or the residual looks
              unrelated to the emission the rest of the screen talks about. */}
          <span className="text-xs font-mono text-muted-foreground border border-border rounded-full px-2 py-0.5">
            you still need ≈ {residualNeed(snap).toLocaleString()} t
            {residualNeed(snap) !== Math.round(expected) && (
              <> of {expected.toLocaleString()}</>
            )}
          </span>
          {snap.prevMarketPrice !== null && (
            <span className="text-xs font-mono text-primary border border-primary/30 rounded-full px-2 py-0.5">
              last round ≈ {r1(snap.prevMarketPrice)}
            </span>
          )}
          <span className="text-xs font-mono text-accent border border-accent/30 rounded-full px-2 py-0.5">
            supply {snap.auctionSupply.toLocaleString()} cr
          </span>
        </div>
      </div>

      <FlowHint steps={CAP_FLOW.auctioning} />

      <div className="flex flex-col gap-2 mt-5">
        <div className="grid grid-cols-[1fr_1fr_2rem] gap-3">
          <label className="text-[10px] font-mono uppercase text-muted-foreground">Quantity (cr)</label>
          <label className="text-[10px] font-mono uppercase text-muted-foreground">Max price / credit</label>
          <span />
        </div>
        {steps.map((step, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_2rem] gap-3 items-center">
            <Input
              type="number"
              min={0}
              step="0.1"
              value={step.qty}
              aria-label={`Step ${i + 1} quantity`}
              onChange={(e) => setStep(i, { qty: Math.max(0, Number(e.target.value)) })}
              className="font-mono text-right"
            />
            <Input
              type="number"
              min={0}
              step="0.1"
              value={step.price}
              aria-label={`Step ${i + 1} max price`}
              onChange={(e) => setStep(i, { price: Math.max(0, Number(e.target.value)) })}
              className="font-mono text-right"
            />
            {steps.length > 1 ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeStep(i)}
                aria-label={`Remove step ${i + 1}`}
                className="h-8 w-8"
              >
                <X size={14} />
              </Button>
            ) : (
              <span />
            )}
          </div>
        ))}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={addStep}
            disabled={steps.length >= MAX_SWEEP_STEPS}
            className="font-mono text-xs"
          >
            <Plus size={12} /> Add step
          </Button>
          <span className="text-[11px] font-mono text-muted-foreground">
            {steps.length > 1
              ? `sweep · ${steps.length} of ${MAX_SWEEP_STEPS} steps`
              : `add steps to bid a curve (up to ${MAX_SWEEP_STEPS})`}
          </span>
        </div>
        {steps.length > 1 && (
          <p className="text-[11px] text-muted-foreground leading-snug">
            Each step is ranked like a separate bid. If the auction clears at price p, you win every
            step priced at p or above and pay p for each credit.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between mt-5">
        <span className="text-xs font-mono text-muted-foreground">
          {live.length > 1
            ? `${total.toLocaleString()} cr in total · at most ${worst.cost.toLocaleString()} if it clears at ${worst.at}`
            : `If fully won: up to ${worst.cost.toLocaleString()} cost`}
        </span>
        <Button onClick={() => void submit()} disabled={busy} className="font-bold">
          {committed ? (
            <>
              <Check size={14} /> Update bid
            </>
          ) : (
            'Submit bid'
          )}
        </Button>
      </div>
      {committed && (
        <p className="text-xs text-primary font-mono mt-2 flex items-center gap-1">
          <Check size={12} /> Bid in{bidSteps(committed).length > 1 ? ` (${describeSteps(bidSteps(committed))})` : ''} —
          changeable until the instructor closes the auction.
        </p>
      )}
    </div>
  )
}

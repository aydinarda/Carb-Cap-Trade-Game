import { ArrowRightLeft, Leaf, ShieldCheck, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn, EcoDots, GameTitle } from './theme'

/**
 * The pieces the two front doors share — the player's join page and the instructor's create
 * page.
 *
 * They are one product and should read as one, but they are NOT the same page: a student
 * arrives on a phone with a four-character code from the projector, and an instructor
 * arrives on a laptop about to configure a session. Sharing the frame and splitting the body
 * is what keeps them consistent without pretending the two jobs are the same.
 */

/** The full-bleed dark frame both landing pages sit in. */
export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen bg-background overflow-x-hidden">
      <EcoDots />
      {/* Wide enough that the hero's second line fits on ONE line at desktop widths — it is
          a two-line headline, and letting it break to three turns the shape into a wall. */}
      <div className="relative z-10 mx-auto max-w-6xl px-4 sm:px-6 pb-20">{children}</div>
    </div>
  )
}

/** The leaf-and-swap mark. Small enough to sit in a nav bar, legible at 32px. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <div
      className="rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center relative shrink-0"
      style={{ width: size, height: size }}
    >
      <Leaf size={size * 0.5} className="text-primary" />
      <span
        className="absolute -top-1 -right-1 rounded-full bg-accent flex items-center justify-center"
        style={{ width: size * 0.3, height: size * 0.3 }}
      >
        <ArrowRightLeft size={size * 0.17} className="text-accent-foreground" />
      </span>
    </div>
  )
}

/**
 * Top bar.
 *
 * One link and nothing else. `cta` is the door to the OTHER side of the product, so a
 * student who is actually the instructor is one click from the right page, and vice versa.
 *
 * There is no rules or about link. Both pages already answer the only question someone has
 * on the way in — which industry am I, or which allocation rule am I running — and the rules
 * are explained in the game, at the moment each one starts to matter. A nav full of reading
 * beside a four-field form is a nav that competes with the form.
 */
export function LandingNav({ cta }: { cta: { label: string; to: string } }) {
  return (
    <header className="flex items-center justify-between gap-3 py-6">
      <Link to="/" className="flex items-center gap-3 min-w-0 shrink-0">
        <BrandMark size={40} />
        {/* The wordmark is two words of Unbounded Black; on a 390px phone it wraps and the
            nav lands on top of it. The mark alone still identifies the product, and the
            title is repeated in the hero immediately below. */}
        <span className="hidden sm:block">
          <GameTitle small />
        </span>
      </Link>
      <nav className="flex items-center min-w-0">
        <Link
          to={cta.to}
          className="ml-1 rounded-lg border border-primary/50 text-primary px-2.5 sm:px-4 py-2 text-xs sm:text-sm font-bold hover:bg-primary/10 transition-colors whitespace-nowrap"
        >
          {cta.label}
        </Link>
      </nav>
    </header>
  )
}

/** The headline block. `accent` is the second line, in the primary colour. */
export function LandingHero({
  lead,
  accent,
  subtitle,
}: {
  lead: string
  accent: string
  subtitle: ReactNode
}) {
  return (
    <div className="text-center pt-6 sm:pt-10 pb-8">
      {/* Sized so the ACCENT line — the longer of the two — stays on one line at each
          breakpoint. A headline that breaks to three lines reads as a paragraph. */}
      <h2
        className="text-[1.75rem] sm:text-4xl lg:text-5xl xl:text-[3.25rem] font-black leading-[1.08] tracking-tight text-balance"
        style={{ fontFamily: "'Unbounded', sans-serif" }}
      >
        <span className="text-foreground">{lead}</span>
        <br />
        <span className="text-primary">{accent}</span>
      </h2>
      <p className="text-muted-foreground mt-5 max-w-xl mx-auto leading-relaxed">{subtitle}</p>
    </div>
  )
}

/**
 * The three things a player does, as a strip under the hero.
 *
 * Colours are the game's own: cyan is the market wherever it appears, lime is your own
 * company's abatement and its compliance. Somebody who reads this strip and then opens the
 * trade screen meets the same two hues doing the same two jobs.
 */
export function LandingFeatures() {
  const items = [
    {
      icon: <TrendingUp size={20} />,
      color: 'text-market',
      title: 'Trade',
      body: 'Buy and sell allowances at the market price',
    },
    {
      icon: <Leaf size={20} />,
      color: 'text-primary',
      title: 'Abate',
      body: 'Invest in permanent cuts — live from next year',
    },
    {
      icon: <ShieldCheck size={20} />,
      color: 'text-primary',
      title: 'Comply',
      body: 'Cover your gap, or pay the fine and still owe it',
    },
  ]
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border rounded-xl overflow-hidden mb-10">
      {items.map((i) => (
        <div key={i.title} className="bg-background flex items-start gap-3 px-5 py-4">
          <span className={cn('mt-0.5 shrink-0', i.color)}>{i.icon}</span>
          <div className="min-w-0">
            <h3 className="font-bold text-foreground">{i.title}</h3>
            <p className="text-sm text-muted-foreground leading-snug mt-0.5">{i.body}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The bordered panel each landing page's form sits in. */
export function LandingCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card/60 p-5 sm:p-7 flex flex-col gap-5">
      {children}
    </div>
  )
}

/** A small mono caption above a field or a group of them. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  )
}

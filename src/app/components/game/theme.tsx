import { Factory, FlaskConical, Truck, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Industry } from '@shared/constants'
import type { CapMode } from '@shared/types'

export function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

/**
 * The semantic hues, mirrored from `src/styles/theme.css` for the places that cannot use a
 * Tailwind class — SVG `stroke`/`fill`, and anything handed to a chart library as a string.
 *
 * Kept as literals rather than read from the cascade because charts are rendered to SVG
 * attributes, where `var(--primary)` does not resolve in every browser we care about. When
 * a token in theme.css moves, move it here too — these two lists are the palette.
 */
export const PALETTE = {
  background: '#021910',
  card: '#082b1f',
  surfaceAlt: '#0d3425',
  border: '#175438',
  primary: '#63f45b',
  primaryBright: '#8cff5a',
  market: '#20d9ff',
  accent: '#ffb31a',
  destructive: '#ff5263',
  insight: '#b77cff',
  foreground: '#e7f5e6',
  mutedForeground: '#8eaa96',
} as const

// Categorical hues for the four sectors — identities, not measures, so they are chosen for
// separation from each other rather than from the semantic scale above.
//
// They are deliberately NOT the semantic hues: a Transport badge in market cyan would read
// as "this is the market", and the whole point of the palette is that a hue means one thing.
// Each is darkened against the new, darker background (#021910) so a badge sits on the
// surface rather than glowing off it. Industry identity is never colour-alone — every badge
// pairs the hue with an icon and a label.
export const INDUSTRY_META: Record<Industry, { icon: ReactNode; color: string }> = {
  'Power & Utilities': { icon: <Zap size={14} />, color: '#d99a1f' },
  'Heavy Materials': { icon: <Factory size={14} />, color: '#d1703a' },
  'Manufacturing & Chemicals': { icon: <FlaskConical size={14} />, color: '#3fb0e0' },
  Transport: { icon: <Truck size={14} />, color: '#4cc244' },
}

/** Non-categorical chart colors: measures, not identities. */
export const CHART = {
  series: PALETTE.primary, // the player's own single-series line / realized totals
  reference: PALETTE.mutedForeground, // caps, allocations, baselines (dashed reference marks)
  grid: 'rgba(231,245,230,0.07)',
  axis: 'rgba(231,245,230,0.45)',
  surplus: PALETTE.primary,
  shortage: PALETTE.destructive,
  market: PALETTE.market,
}

export const MODE_LABELS = {
  grandfathering: {
    label: 'Grandfathering',
    tagline: 'Free credits proportional to your emission history',
    desc: 'The early ETS model: the class baseline is given out for free, split in proportion to each company\'s past ten years of emissions — and then cut every year, so the free ride runs out.',
    implemented: true,
  },
  benchmarking: {
    label: 'Benchmarking',
    tagline: 'One benchmark per sector, tightened every year',
    desc: 'The EU model: every company in a sector gets the same free credits — the sector benchmark — regardless of its own history. It opens near the sector average, so year one is comfortable, and then shrinks every year until an average emitter is short and only an efficient one is long. There is no primary sale: close the gap by cutting emissions or on the secondary market.',
    implemented: true,
  },
  auctioning: {
    label: 'Auctioning',
    tagline: 'No free credits — buy every allowance at auction',
    desc: 'The modern ETS model: no free credits. The regulator puts a fixed supply on offer at a sealed-bid uniform-price auction, and every allowance is bought there or on the secondary market.',
    implemented: true,
  },
  hybrid: {
    label: 'Hybrid (Benchmark + Auction)',
    tagline: 'Some sectors get their benchmark free — the rest of the cap is auctioned',
    desc: 'What the EU actually does: the cap is set first, then chosen sectors receive a share of their benchmark for free and everything left over goes to the sealed-bid auction. Free allocation is subtracted from the auction, never added on top — so a sector that keeps its free credits is shrinking the pool everyone else has to bid for.',
    implemented: true,
  },
} as const

/**
 * How each stage works, as a sequence of short steps — rendered by `FlowHint`.
 *
 * These replaced the paragraph-long banners each screen used to carry. Rules copy nobody
 * finishes reading is worse than no copy, and both stages are genuinely sequential, so the
 * arrows do the work the prose was burying. Anything that is a *number* about this player
 * belongs on a StatCard, not in here: these strings never interpolate state, which is what
 * keeps them short enough to scan.
 *
 * Keep each step to roughly three to six words. If a step needs a sentence, it is not a step.
 */
export const CAP_FLOW: Record<CapMode, string[]> = {
  grandfathering: [
    'Free credits from your history',
    'No fixed-price sale',
    'Cover the rest on the market',
  ],
  benchmarking: [
    'One benchmark for your whole sector',
    'Shrinks every year',
    'Average emitters run short',
    'Close the gap on the market',
  ],
  auctioning: [
    'No free credits',
    'Bid a quantity and a max price',
    'Highest bidders win the supply',
    'Everyone pays one clearing price',
  ],
  hybrid: [
    'Your sector may get free credits',
    'What is given away leaves the auction',
    'Bid for the rest, with a max price',
    'Everyone pays one clearing price',
  ],
}

/** Once the market is open the rules are the same whatever issued the credits. */
const TRADE_FLOW_COMMON = [
  'Bid to buy, ask to sell',
  'Best price matches, no shorting',
  'Uncovered pays the fine and still carries',
  'Surplus banks for next year',
]

/** The trade stage. Step one names where your credits came from; the rest is common. */
export const TRADE_FLOW: Record<CapMode, string[]> = {
  grandfathering: ['Trade your free credits', ...TRADE_FLOW_COMMON],
  benchmarking: ['Trade your benchmark credits', ...TRADE_FLOW_COMMON],
  auctioning: ['Trade what you won at auction', ...TRADE_FLOW_COMMON],
  hybrid: ['Trade your free and auctioned credits', ...TRADE_FLOW_COMMON],
}

/** Backend bot archetype labels (auctioning mode). */
export const BOT_LABELS: Record<'compliance' | 'marketMaker' | 'speculator' | 'noise', string> = {
  compliance: 'Compliance',
  marketMaker: 'Market maker',
  speculator: 'Speculator',
  noise: 'Noise',
}

/** Floating background circles carried over from the original prototype. */
export function EcoDots({ className }: { className?: string }) {
  return (
    <div className={cn('absolute inset-0 overflow-hidden pointer-events-none', className)}>
      {[
        { size: 48, top: '8%', left: '4%', ci: 0 },
        { size: 64, top: '20%', left: '82%', ci: 1 },
        { size: 32, top: '65%', left: '12%', ci: 2 },
        { size: 80, top: '75%', left: '88%', ci: 0 },
        { size: 40, top: '45%', left: '55%', ci: 1 },
        { size: 24, top: '30%', left: '30%', ci: 2 },
      ].map((d, i) => (
        <div
          key={i}
          className="absolute rounded-full"
          style={{
            width: d.size,
            height: d.size,
            top: d.top,
            left: d.left,
            background:
              d.ci === 0
                ? 'rgba(99,244,91,0.05)'
                : d.ci === 1
                  ? 'rgba(255,179,26,0.04)'
                  : 'rgba(32,217,255,0.04)',
            border: `1px solid ${
              d.ci === 0
                ? 'rgba(99,244,91,0.1)'
                : d.ci === 1
                  ? 'rgba(255,179,26,0.08)'
                  : 'rgba(32,217,255,0.07)'
            }`,
          }}
        />
      ))}
    </div>
  )
}

export function GameTitle({ small }: { small?: boolean }) {
  return (
    <h1
      className={cn(
        'font-black text-foreground leading-none tracking-tight',
        small ? 'text-xl' : 'text-4xl md:text-5xl',
      )}
      style={{ fontFamily: "'Unbounded', sans-serif" }}
    >
      Carbon <span className="text-primary">Cap&amp;Trade</span>
    </h1>
  )
}

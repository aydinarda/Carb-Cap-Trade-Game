import { Factory, FlaskConical, Truck, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Industry } from '@shared/constants'
import type { CapMode } from '@shared/types'

export function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

// Categorical hues validated for the dark surface (#071a0e) with
// scripts/validate_palette.js: lightness band, chroma, CVD separation, contrast.
// Industry identity is never color-alone — badges pair the hue with an icon + label.
export const INDUSTRY_META: Record<Industry, { icon: ReactNode; color: string }> = {
  'Power & Utilities': { icon: <Zap size={14} />, color: '#bd7f12' },
  'Heavy Materials': { icon: <Factory size={14} />, color: '#c2632e' },
  'Manufacturing & Chemicals': { icon: <FlaskConical size={14} />, color: '#2b9fd8' },
  Transport: { icon: <Truck size={14} />, color: '#3dad35' },
}

/** Non-categorical chart colors: measures, not identities. */
export const CHART = {
  series: '#5dde52', // the player's own single-series line / realized totals
  reference: '#8fa596', // caps, allocations, baselines (dashed reference marks)
  grid: 'rgba(223,242,216,0.08)',
  axis: 'rgba(223,242,216,0.45)',
  surplus: '#5dde52',
  shortage: '#e03e3e',
}

export const MODE_LABELS = {
  grandfathering: {
    label: 'Grandfathering',
    tagline: 'Free credits proportional to your emission history',
    desc: 'The early ETS model: 80% of the class baseline is given out for free, split in proportion to each company\'s past ten years of emissions.',
    implemented: true,
  },
  benchmarking: {
    label: 'Benchmarking',
    tagline: 'A sector benchmark set 40% below the sector average',
    desc: 'The EU model: every company in a sector gets the same free credits — the sector benchmark — regardless of its own history. Set 40% below the sector average, so an average emitter is short and only an efficient one is long. There is no primary sale: close the gap by cutting emissions or on the secondary market.',
    implemented: true,
  },
  auctioning: {
    label: 'Auctioning',
    tagline: 'No free credits — buy every allowance at auction',
    desc: 'The modern ETS model: no free credits. The regulator puts a fixed supply on offer at a sealed-bid uniform-price auction, and every allowance is bought there or on the secondary market.',
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
    'Set below the sector average',
    'Average emitters run short',
    'Close the gap on the market',
  ],
  auctioning: [
    'No free credits',
    'Bid a quantity and a max price',
    'Highest bidders win the supply',
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
                ? 'rgba(93,222,82,0.05)'
                : d.ci === 1
                  ? 'rgba(245,166,35,0.04)'
                  : 'rgba(56,189,248,0.04)',
            border: `1px solid ${
              d.ci === 0
                ? 'rgba(93,222,82,0.1)'
                : d.ci === 1
                  ? 'rgba(245,166,35,0.08)'
                  : 'rgba(56,189,248,0.07)'
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

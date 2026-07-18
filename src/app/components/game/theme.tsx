import { Factory, FlaskConical, Truck, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Industry } from '@shared/constants'

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
    tagline: 'A flat free allowance per industry',
    desc: 'Every company in an industry gets the same free credits — the industry benchmark you set — regardless of its own history. The regulator sells the rest at the fixed price.',
    implemented: true,
  },
  auctioning: {
    label: 'Auctioning',
    tagline: 'No free credits — buy every allowance',
    desc: 'The modern ETS model: no free credits. Every allowance is bought from the regulator at the fixed price (the full baseline is on sale, pro-rata if oversubscribed).',
    implemented: true,
  },
} as const

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

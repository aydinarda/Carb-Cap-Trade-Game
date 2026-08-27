import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ClassAggregate, YouView } from '@shared/types'
import { CHART, PALETTE } from './theme'

const tooltipStyle = {
  background: PALETTE.card,
  border: `1px solid ${PALETTE.border}`,
  borderRadius: 8,
  fontSize: 12,
  fontFamily: "'DM Mono', monospace",
  color: PALETTE.foreground,
}

const axisTick = { fill: CHART.axis, fontSize: 11, fontFamily: "'DM Mono', monospace" }

/** A player's yearly emissions: 10-year generated history plus realized game years. */
export function EmissionHistoryChart({
  you,
  height = 220,
}: {
  you: YouView
  height?: number
}) {
  const data = Object.entries(you.emissions)
    .map(([year, value]) => ({ year: Number(year), emissions: value }))
    .sort((a, b) => a.year - b.year)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis
          dataKey="year"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: CHART.grid }}
          tickFormatter={(y: number) => `Y${y}`}
        />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={44} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(y) => `Year ${y}`}
          formatter={(value: number) => [`${value} tCO₂`, 'Emissions']}
        />
        {/* Only when there IS a free allocation. Under auctioning it is 0, and a reference
            line pinned to the axis is not a cap anyone was given — it is a line labelled
            "free credits" sitting on zero, which reads as a mistake and collides with the
            axis labels. No allocation, no line. */}
        {you.freeAllocation !== null && you.freeAllocation > 0 && (
          <ReferenceLine
            y={you.freeAllocation}
            stroke={CHART.reference}
            strokeDasharray="5 4"
            label={{
              value: 'free credits',
              position: 'insideTopRight',
              fill: CHART.axis,
              fontSize: 10,
            }}
          />
        )}
        <Line
          type="monotone"
          dataKey="emissions"
          stroke={CHART.series}
          strokeWidth={2}
          dot={(props: { cx?: number; cy?: number; payload?: { year: number } }) => {
            const realized = (props.payload?.year ?? 0) > 10
            return (
              <circle
                key={props.payload?.year}
                cx={props.cx}
                cy={props.cy}
                r={realized ? 5 : 3}
                fill={realized ? PALETTE.accent : CHART.series}
                stroke={PALETTE.background}
                strokeWidth={2}
              />
            )
          }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/** Class total realized emissions vs the fixed cap, across completed game years. */
export function ClassYearChart({
  aggregate,
  height = 240,
}: {
  aggregate: ClassAggregate
  height?: number
}) {
  const data = aggregate.yearHistory
  if (data.length === 0) return null

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis
          dataKey="year"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: CHART.grid }}
          tickFormatter={(y: number) => `Y${y}`}
        />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={54} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(y) => `Year ${y}`}
          formatter={(value: number, name: string) => [
            `${value.toLocaleString()} tCO₂`,
            name === 'totalRealized' ? 'Class emissions' : 'Cap',
          ]}
        />
        <Legend
          formatter={(value: string) => (
            <span style={{ color: CHART.axis, fontSize: 11 }}>
              {value === 'totalRealized' ? 'Class emissions' : 'Cap (free credit limit)'}
            </span>
          )}
        />
        <Line
          type="monotone"
          dataKey="cap"
          stroke={CHART.reference}
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="totalRealized"
          stroke={CHART.series}
          strokeWidth={2}
          dot={{ r: 4, fill: CHART.series, stroke: PALETTE.background, strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/** Allocated vs realized totals per industry for the current year. */
export function IndustryBreakdownChart({
  aggregate,
  height = 240,
}: {
  aggregate: ClassAggregate
  height?: number
}) {
  const data = aggregate.industryBreakdown.map((row) => ({
    ...row,
    shortLabel: row.industry.split(' ')[0],
  }))
  const hasRealized = data.some((d) => d.realized !== null)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={2}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis
          dataKey="shortLabel"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: CHART.grid }}
        />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={54} />
        <Tooltip
          cursor={{ fill: 'rgba(223,242,216,0.04)' }}
          contentStyle={tooltipStyle}
          formatter={(value: number, name: string) => [
            `${value.toLocaleString()} tCO₂`,
            name === 'allocated' ? 'Free allocation' : 'Realized emissions',
          ]}
          labelFormatter={(_, payload) => payload?.[0]?.payload.industry ?? ''}
        />
        <Legend
          formatter={(value: string) => (
            <span style={{ color: CHART.axis, fontSize: 11 }}>
              {value === 'allocated' ? 'Free allocation' : 'Realized emissions'}
            </span>
          )}
        />
        <Bar dataKey="allocated" fill={CHART.reference} radius={[4, 4, 0, 0]} maxBarSize={36} />
        {hasRealized && (
          <Bar dataKey="realized" fill={CHART.series} radius={[4, 4, 0, 0]} maxBarSize={36} />
        )}
      </BarChart>
    </ResponsiveContainer>
  )
}

import type { HostSnapshot } from '@shared/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { IndustryBadge } from '../../components/game/cards'

/** Host-only: full year-by-year history for one company, opened from the leaderboard. */
export function PlayerHistoryDialog({
  snap,
  playerId,
  onClose,
}: {
  snap: HostSnapshot
  playerId: string | null
  onClose: () => void
}) {
  const player = playerId ? snap.players.find((p) => p.id === playerId) : null
  const rows = playerId ? (snap.playerHistory[playerId] ?? []) : []
  const board = playerId ? snap.leaderboard.find((r) => r.id === playerId) : null

  const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString())

  return (
    <Dialog open={playerId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {player ? (
              <>
                <span className="font-mono">{player.id}</span>
                <span>{player.name}</span>
                <IndustryBadge industry={player.industry} size="sm" />
              </>
            ) : (
              'Player history'
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs font-mono uppercase tracking-wider text-muted-foreground text-left">
                <th className="py-2 pr-3 font-normal">Year</th>
                <th className="py-2 pr-3 font-normal text-right">Expected</th>
                <th className="py-2 pr-3 font-normal text-right">Realized</th>
                <th className="py-2 pr-3 font-normal text-right">Free</th>
                <th className="py-2 pr-3 font-normal text-right">Reg</th>
                <th className="py-2 pr-3 font-normal text-right">Bought</th>
                <th className="py-2 pr-3 font-normal text-right">Sold</th>
                <th className="py-2 pr-3 font-normal text-right">Cut</th>
                <th className="py-2 pr-3 font-normal text-right">Held</th>
                <th className="py-2 font-normal text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {rows.map((r) => (
                <tr key={r.year}>
                  <td className="py-2 pr-3 font-bold">{r.year}</td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">{num(r.expected)}</td>
                  <td className="py-2 pr-3 text-right text-accent">{num(r.realized)}</td>
                  <td className="py-2 pr-3 text-right">{num(r.free)}</td>
                  <td className="py-2 pr-3 text-right">{num(r.regulatorGranted)}</td>
                  <td className="py-2 pr-3 text-right">{num(r.secondaryBought)}</td>
                  <td className="py-2 pr-3 text-right">{num(r.secondarySold)}</td>
                  <td className="py-2 pr-3 text-right">{Math.round(r.abatement * 100)}%</td>
                  <td className="py-2 pr-3 text-right">{num(r.creditsHeld)}</td>
                  <td className="py-2 text-right font-bold">{num(r.settlement?.yearCost)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-4 text-center text-muted-foreground">
                    No completed years yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {board && (
          <div className="text-xs font-mono text-muted-foreground pt-2 border-t border-border flex justify-between">
            <span>
              Cumulative cost: <span className="text-foreground font-bold">{num(board.score)}</span>
            </span>
            <span>
              Skill score (vs own optimum):{' '}
              <span className="text-foreground font-bold">{num(board.normalizedScore)}</span>
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

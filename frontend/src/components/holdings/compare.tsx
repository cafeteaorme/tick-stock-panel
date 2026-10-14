import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Scale } from 'lucide-react'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { fmtMoney, fmtPct, pnlColor } from './shared'

/** 多账户对比 (折叠卡): 持仓/当日盈亏 (本地) × 年收益/累计 (账本分桶) */
export function AccountsCompareCard({ onPick }: { onPick?: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const accountsQ = useQuery({ queryKey: QK.holdingsAccounts, queryFn: api.holdingsAccounts })
  const histQ = useQuery({
    queryKey: [...QK.holdingsTzzbHistoryData, 'merged'],
    queryFn: () => api.holdingsTzzbHistoryData(),
    staleTime: 5 * 60_000,
  })

  const year = new Date().getFullYear()
  const rows = useMemo(() => {
    const buckets = histQ.data?.accounts ?? {}
    const byName = new Map(Object.values(buckets).map(b => [b.name, b]))
    return (accountsQ.data?.accounts ?? []).map(a => {
      const b = byName.get(a.name)
      const yr = b?.yearly?.find(y => y.period === String(year))?.pnl
      const cum = b?.curve?.[b.curve.length - 1]?.cum
      return { id: a.id, name: a.name, positions: a.positions ?? 0, dayPnl: a.day_pnl, dayPct: a.day_pnl_pct, yearPnl: yr, cum }
    })
  }, [accountsQ.data, histQ.data, year])

  const totals = useMemo(() => ({
    day: rows.reduce((s, r) => s + (r.dayPnl ?? 0), 0),
    year: rows.reduce((s, r) => s + (r.yearPnl ?? 0), 0),
    cum: rows.reduce((s, r) => s + (r.cum ?? 0), 0),
  }), [rows])

  return (
    <div className="rounded-card border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <Scale className="h-4 w-4 text-accent" />
        <button onClick={() => setOpen(v => !v)} className="text-sm font-semibold text-foreground">账户对比</button>
        <span className="text-xs text-muted">{rows.length} 账户</span>
        {open && (
          <span className="text-xs text-muted tabular-nums">
            当日 <b className={pnlColor(totals.day)}>{fmtMoney(totals.day, 0)}</b>
            {' · '}年 <b className={pnlColor(totals.year)}>{fmtMoney(totals.year, 0)}</b>
            {' · '}累计 <b className={pnlColor(totals.cum)}>{fmtMoney(totals.cum, 0)}</b>
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-muted/70">年/累计为账本口径</span>
        <button onClick={() => setOpen(v => !v)} className="text-[11px] text-accent hover:underline">{open ? '收起' : '展开'}</button>
      </div>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-muted border-b border-border/60 bg-elevated/30">
                {['账户', '持仓', '当日盈亏', '年收益(账本)', '累计(账本)'].map(h => (
                  <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}
                  className={`border-b border-border/40 hover:bg-elevated/30 ${onPick ? 'cursor-pointer' : ''}`}
                  onClick={() => onPick?.(r.id)}>
                  <td className="px-3 py-2 text-foreground font-medium whitespace-nowrap">{r.name}</td>
                  <td className="px-3 py-2 tabular-nums text-secondary">{r.positions} 只</td>
                  <td className={`px-3 py-2 tabular-nums font-medium ${pnlColor(r.dayPnl)}`}>
                    {r.dayPnl != null ? fmtMoney(r.dayPnl) : '…'}
                    {r.dayPct != null && <span className="text-[10px] ml-1 text-muted">{fmtPct(r.dayPct)}</span>}
                  </td>
                  <td className={`px-3 py-2 tabular-nums ${pnlColor(r.yearPnl)}`}>{r.yearPnl != null ? fmtMoney(r.yearPnl, 0) : '—'}</td>
                  <td className={`px-3 py-2 tabular-nums ${pnlColor(r.cum)}`}>{r.cum != null ? fmtMoney(r.cum, 0) : '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-muted">暂无账户</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

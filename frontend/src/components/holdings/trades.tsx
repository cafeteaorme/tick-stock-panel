import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { fmtMoney, pnlColor } from './shared'

const PAGE_SIZE = 50

/** 成交历史 (账本真实成交缓存, 按当前账户过滤; 筛选 + 分页 + 移动卡片) */
export function TradesHistorySection({ account, onOpenSymbol }: {
  account?: string
  onOpenSymbol: (symbol: string, name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [sym, setSym] = useState('')
  const [bs, setBs] = useState<'' | 'B' | 'S'>('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [page, setPage] = useState(0)

  const q = useQuery({
    queryKey: [...QK.holdingsTzzbTrades, 'list', account, sym, bs, start, end],
    queryFn: () => api.holdingsTzzbTradesList({
      account: account || undefined, symbol: sym || undefined,
      bs: bs || undefined, start: start || undefined, end: end || undefined,
    }),
    enabled: open && !!account,
    staleTime: 60_000,
  })

  const trades = useMemo(() => q.data?.trades ?? [], [q.data])
  const pages = Math.max(1, Math.ceil(trades.length / PAGE_SIZE))
  const cur = Math.min(page, pages - 1)
  const slice = trades.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE)
  const realized = useMemo(() =>
    trades.reduce((a, t) => a + (t.profit ?? 0), 0), [trades])

  const header = (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm font-semibold text-foreground">成交历史</span>
      <span className="text-xs text-muted">{q.data ? `${q.data.n_filtered ?? trades.length} 笔` : '账本真实成交'}</span>
      {trades.length > 0 && trades.some(t => t.profit) && (
        <span className={`text-xs tabular-nums ${pnlColor(realized)}`} title="筛选范围内已实现盈亏">已实现 {fmtMoney(realized, 0)}</span>
      )}
      <div className="flex-1" />
      <a href={`/api/holdings/export/trades.csv${account ? `?account=${encodeURIComponent(account)}` : ''}`}
        className="text-[11px] text-accent hover:underline">导出 CSV</a>
      <button onClick={() => setOpen(v => !v)} className="text-[11px] text-accent hover:underline">
        {open ? '收起' : '展开'}
      </button>
    </div>
  )

  if (!open) {
    return (
      <div className="rounded-card border border-border bg-surface px-4 py-3">
        {header}
      </div>
    )
  }

  return (
    <div className="rounded-card border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex-wrap">{header}</div>

      {/* 筛选条 */}
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 flex-wrap text-xs">
        <div className="flex items-center gap-1 bg-base border border-border rounded-btn px-2 h-8">
          <Search className="h-3.5 w-3.5 text-muted shrink-0" />
          <input value={sym} onChange={e => { setSym(e.target.value.trim()); setPage(0) }}
            placeholder="代码/名称" className="w-24 bg-transparent outline-none text-foreground" />
        </div>
        <div className="inline-flex rounded-btn bg-elevated overflow-hidden">
          {([['', '全部'], ['B', '买入'], ['S', '卖出']] as const).map(([v, l]) => (
            <button key={v} onClick={() => { setBs(v as '' | 'B' | 'S'); setPage(0) }}
              className={`px-2.5 py-1 text-[11px] ${bs === v ? 'bg-accent/20 text-accent font-medium' : 'text-muted hover:text-secondary'}`}>{l}</button>
          ))}
        </div>
        <input type="date" value={start} onChange={e => { setStart(e.target.value); setPage(0) }}
          className="h-8 px-2 rounded-btn bg-base border border-border text-foreground text-[11px]" />
        <span className="text-muted">~</span>
        <input type="date" value={end} onChange={e => { setEnd(e.target.value); setPage(0) }}
          className="h-8 px-2 rounded-btn bg-base border border-border text-foreground text-[11px]" />
      </div>

      {q.isLoading ? (
        <div className="px-4 py-8 text-center text-xs text-muted">成交加载中…</div>
      ) : trades.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-muted">无匹配成交 (先在后台任务拉取真实成交)</div>
      ) : (
        <>
          {/* 桌面表格 */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-muted border-b border-border/60 bg-elevated/30">
                  {['日期时间', '账户', '名称/代码', '方向', '数量', '价格', '金额', '费用', '已实现'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slice.map((t, i) => (
                  <tr key={`${t.date}-${t.time}-${t.symbol}-${i}`}
                    className="border-b border-border/40 hover:bg-elevated/30 cursor-pointer"
                    onClick={() => onOpenSymbol(t.symbol, t.name || '')}>
                    <td className="px-3 py-2 tabular-nums text-secondary whitespace-nowrap">{t.date} {t.time}</td>
                    <td className="px-3 py-2 text-muted text-xs whitespace-nowrap">{t.account_name}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-foreground font-medium">{t.name || '—'}</span>
                      <span className="font-mono text-muted text-xs ml-1.5">{t.symbol}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${t.bs === 'B' ? 'bg-[#ef4444]/15 text-[#ef4444]' : 'bg-[#22c55e]/15 text-[#22c55e]'}`}>{t.bs === 'B' ? '买' : '卖'}</span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-secondary">{t.qty}</td>
                    <td className="px-3 py-2 tabular-nums">{t.price?.toFixed(3) ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-secondary">{fmtMoney(t.amount, 0)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted">{t.fee != null ? fmtMoney(t.fee, 2) : '—'}</td>
                    <td className={`px-3 py-2 tabular-nums ${pnlColor(t.profit)}`}>{t.profit ? fmtMoney(t.profit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 移动卡片 */}
          <div className="md:hidden divide-y divide-border/40">
            {slice.map((t, i) => (
              <div key={`${t.date}-${t.time}-${t.symbol}-${i}`}
                className="px-3 py-2 cursor-pointer active:bg-elevated/40"
                onClick={() => onOpenSymbol(t.symbol, t.name || '')}>
                <div className="flex items-center gap-1.5">
                  <span className={`px-1.5 py-px rounded text-[10px] font-bold ${t.bs === 'B' ? 'bg-[#ef4444]/15 text-[#ef4444]' : 'bg-[#22c55e]/15 text-[#22c55e]'}`}>{t.bs === 'B' ? '买' : '卖'}</span>
                  <span className="text-foreground font-medium truncate text-sm">{t.name || t.symbol}</span>
                  <span className="font-mono text-[10px] text-muted shrink-0">{t.symbol}</span>
                  <div className="flex-1" />
                  <span className="text-[10px] text-muted tabular-nums">{t.date.slice(5)} {t.time}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-3 text-xs tabular-nums">
                  <span className="text-secondary">{t.qty} 股 @ {t.price?.toFixed(3) ?? '—'}</span>
                  <span className="text-muted">{fmtMoney(t.amount, 0)}</span>
                  {t.profit ? <span className={pnlColor(t.profit)}>{fmtMoney(t.profit, 0)}</span> : null}
                </div>
              </div>
            ))}
          </div>

          {/* 分页 */}
          <div className="px-3 py-2 border-t border-border/60 flex items-center gap-2 text-xs text-muted">
            <button disabled={cur === 0} onClick={() => setPage(cur - 1)}
              className="px-2 py-1 rounded-btn bg-elevated text-secondary hover:text-foreground disabled:opacity-40">上一页</button>
            <span className="tabular-nums">{cur + 1} / {pages}</span>
            <button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}
              className="px-2 py-1 rounded-btn bg-elevated text-secondary hover:text-foreground disabled:opacity-40">下一页</button>
          </div>
        </>
      )}
    </div>
  )
}

/** 资金流水: 账本资产趋势中的出入金日 + bank 记录 (合并口径, 全部账户) */
export function CashFlowSection({ trend, bank }: {
  trend?: { date: string; asset: number; fundIn: number; fundOut: number }[]
  bank?: Record<string, unknown>[]
}) {
  const [open, setOpen] = useState(false)
  const flows = useMemo(() =>
    (trend ?? []).filter(d => (d.fundIn ?? 0) !== 0 || (d.fundOut ?? 0) !== 0), [trend])
  const totalIn = flows.reduce((a, d) => a + (d.fundIn ?? 0), 0)
  const totalOut = flows.reduce((a, d) => a + (d.fundOut ?? 0), 0)

  return (
    <div className="rounded-card border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <ChevronDown className={`h-3.5 w-3.5 text-muted transition-transform ${open ? '' : '-rotate-90'}`} />
        <button onClick={() => setOpen(v => !v)} className="text-sm font-semibold text-foreground">资金流水</button>
        <span className="text-xs text-muted">{flows.length} 日 · 入 {fmtMoney(totalIn, 0)} / 出 {fmtMoney(Math.abs(totalOut), 0)}</span>
        <span className="text-[10px] text-muted/70">账本 · 全部账户合并</span>
        <div className="flex-1" />
        <button onClick={() => setOpen(v => !v)} className="text-[11px] text-accent hover:underline">{open ? '收起' : '展开'}</button>
      </div>
      {open && (
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          {flows.length === 0 && (bank ?? []).length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted">近月无出入金记录</div>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0">
                <tr className="text-muted border-b border-border/60 bg-elevated/30">
                  {['日期', '入金', '出金', '资产(当日)'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {flows.slice().reverse().map(d => (
                  <tr key={d.date} className="border-b border-border/40">
                    <td className="px-3 py-2 tabular-nums text-secondary">{d.date}</td>
                    <td className="px-3 py-2 tabular-nums text-[#ef4444]">{d.fundIn ? fmtMoney(d.fundIn) : '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-[#22c55e]">{d.fundOut ? fmtMoney(Math.abs(d.fundOut)) : '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-muted">{fmtMoney(d.asset, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

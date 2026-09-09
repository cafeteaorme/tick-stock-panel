import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Briefcase, CalendarDays, ChevronDown, Loader2, Pencil, PieChart as PieIcon,
  Plus, RefreshCw, TrendingUp, Trash2, Wallet, X,
} from 'lucide-react'
import { api, type HoldingRow, type HoldingsSummary } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { toast } from '@/components/Toast'

/* ================================================================
 * 工具
 * ================================================================ */

function fmtMoney(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  if (abs >= 1_0000_0000) return `${sign}${(abs / 1_0000_0000).toFixed(2)}亿`
  if (abs >= 1_0000) return `${sign}${(abs / 1_0000).toFixed(2)}万`
  return `${sign}${abs.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}

const pnlColor = (v: number | null | undefined) =>
  v == null ? 'text-muted' : v > 0 ? 'text-[#ef4444]' : v < 0 ? 'text-[#22c55e]' : 'text-muted'

const REGION_BADGE: Record<string, { label: string; cls: string }> = {
  HK: { label: '港', cls: 'bg-amber-500/12 text-amber-500 border-amber-500/25' },
  US: { label: 'US', cls: 'bg-sky-500/12 text-sky-400 border-sky-500/25' },
}

/* ================================================================
 * 汇总卡
 * ================================================================ */

function SummaryCard({ s, onEditPortfolio }: { s: HoldingsSummary; onEditPortfolio: () => void }) {
  return (
    <div className="rounded-card border border-border bg-surface p-4 md:p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs text-muted">总资产{ s.initial_cap ? <span className="ml-1">（本金 {fmtMoney(s.initial_cap, 0)}）</span> : null }</div>
          <div className="text-2xl md:text-3xl font-bold text-foreground tabular-nums mt-1">{fmtMoney(s.total_asset)}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onEditPortfolio}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground transition-colors"
          >
            <Wallet className="h-3.5 w-3.5" />资金设置
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
        <div>
          <div className="text-[11px] text-muted">当日盈亏</div>
          <div className={`text-sm font-semibold tabular-nums mt-0.5 ${pnlColor(s.day_pnl)}`}>
            {fmtMoney(s.day_pnl)} <span className="text-[11px] font-normal">{fmtPct(s.day_pnl_pct)}</span>
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted">总盈亏（浮+已实现）</div>
          <div className={`text-sm font-semibold tabular-nums mt-0.5 ${pnlColor(s.total_pnl)}`}>
            {fmtMoney(s.total_pnl)} <span className="text-[11px] font-normal">{fmtPct(s.total_pnl_pct)}</span>
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted">持仓市值 / 仓位</div>
          <div className="text-sm font-semibold text-foreground tabular-nums mt-0.5">
            {fmtMoney(s.total_market_value)} <span className="text-[11px] text-muted font-normal">{s.position_pct != null ? `${(s.position_pct * 100).toFixed(1)}%` : '—'}</span>
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted">可用资金 / 持仓数</div>
          <div className="text-sm font-semibold text-foreground tabular-nums mt-0.5">
            {fmtMoney(s.cash)} <span className="text-[11px] text-muted font-normal">{s.positions} 只</span>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ECharts } from 'echarts'

/* ================================================================
 * 收益日历热力图 (纯 div grid, 绿盈红亏)
 * ================================================================ */

function PnlCalendar({ daily }: { daily: { date: string; pnl: number }[] }) {
  const [month, setMonth] = useState(() => {
    const last = daily[daily.length - 1]
    return last ? last.date.slice(0, 7) : new Date().toISOString().slice(0, 7)
  })

  const byDate = useMemo(() => new Map(daily.map(r => [r.date, r])), [daily])
  const monthDays = useMemo(() => daily.filter(r => r.date.startsWith(month)), [daily, month])
  const monthPnl = monthDays.reduce((a, r) => a + r.pnl, 0)
  const monthDates = new Set(monthDays.map(r => r.date))

  // 日历布局: 该月 1 号所在周一开始的 6×7 grid
  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const gridStart = new Date(first)
  gridStart.setDate(1 - ((first.getDay() + 6) % 7)) // 周一开头
  const cells: { date: string | null; pnl?: number }[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const inMonth = d.getMonth() === m - 1
    cells.push(inMonth ? { date: iso, pnl: byDate.get(iso)?.pnl } : { date: null })
  }

  const maxAbs = Math.max(1, ...monthDays.map(r => Math.abs(r.pnl)))
  const bg = (pnl: number | undefined) => {
    if (pnl == null) return 'bg-elevated/40'
    const t = Math.min(Math.abs(pnl) / maxAbs, 1) * 0.55 + 0.12
    return pnl > 0 ? `rgba(239,68,68,${t})` : `rgba(34,197,94,${t})`
  }

  const shiftMonth = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1)
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-foreground">{month.replace('-', ' 年 ')} 月</span>
          <span className={`text-xs tabular-nums ${pnlColor(monthPnl)}`}>{fmtMoney(monthPnl)}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => shiftMonth(-1)} className="p-1 rounded-btn text-secondary hover:bg-elevated rotate-90"><ChevronDown className="h-4 w-4" /></button>
          <button onClick={() => shiftMonth(1)} className="p-1 rounded-btn text-secondary hover:bg-elevated -rotate-90"><ChevronDown className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted mb-1">
        {['一', '二', '三', '四', '五', '六', '日'].map(d => <div key={d}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((c, i) => (
          <div
            key={i}
            title={c.date && c.pnl != null ? `${c.date} · ${fmtMoney(c.pnl)}` : (monthDates.size && c.date && !c.pnl ? `${c.date} · 无数据/休市` : '')}
            className={`aspect-square rounded-md flex flex-col items-center justify-center text-[10px] tabular-nums
              ${c.date ? bg(c.pnl) : 'opacity-0'}
              ${c.pnl != null ? 'text-white font-medium' : 'text-muted'}`}
          >
            {c.date && <span className="opacity-70">{Number(c.date.slice(8))}</span>}
            {c.pnl != null && Math.abs(c.pnl) >= 1 && <span className="text-[9px] leading-tight">{Math.abs(c.pnl) >= 1_0000 ? `${(c.pnl / 1_0000).toFixed(1)}万` : Math.round(c.pnl / (Math.abs(c.pnl) >= 1000 ? 1000 : 1)) + (Math.abs(c.pnl) >= 1000 ? 'k' : '')}</span>}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2 text-[10px] text-muted">
        <span>亏损</span>
        <div className="flex gap-0.5">
          {[0.5, 0.35, 0.2].map(t => <span key={t} className="w-4 h-2 rounded-sm" style={{ background: `rgba(34,197,94,${t})` }} />)}
          <span className="w-4 h-2 rounded-sm bg-elevated/40" />
          {[0.2, 0.35, 0.5].map(t => <span key={t} className="w-4 h-2 rounded-sm" style={{ background: `rgba(239,68,68,${t})` }} />)}
        </div>
        <span>盈利</span>
      </div>
    </div>
  )
}

/* ================================================================
 * 月度柱状图 / 资产曲线 (ECharts)
 * ================================================================ */

function EChart({ option, height }: { option: any; height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  useEffect(() => {
    if (!ref.current) return
    import('echarts').then(echarts => {
      if (!ref.current) return
      if (!chartRef.current) chartRef.current = echarts.init(ref.current)
      chartRef.current.setOption(option, true)
    })
    const onResize = () => chartRef.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [option])
  return <div ref={ref} style={{ height }} />
}

function MonthlyBars({ monthly }: { monthly: { period: string; pnl: number }[] }) {
  const option = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 20, top: 24, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: number) => fmtMoney(v),
      backgroundColor: 'rgba(30,30,36,0.95)', borderColor: '#3f3f46', textStyle: { color: '#e4e4e7', fontSize: 11 },
    },
    xAxis: { type: 'category', data: monthly.map(r => `${Number(r.period.slice(5))}月`), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: (v: number) => fmtMoney(v, 0) }, splitLine: { lineStyle: { color: 'rgba(128,128,140,0.15)' } } },
    series: [{
      type: 'bar', barMaxWidth: 28,
      data: monthly.map(r => ({
        value: r.pnl,
        itemStyle: { color: r.pnl >= 0 ? '#ef4444' : '#22c55e', borderRadius: [3, 3, 0, 0] },
      })),
      label: { show: true, position: 'top', fontSize: 9, formatter: (p: any) => (Math.abs(p.value) >= 100 ? fmtMoney(p.value, 0) : '') },
    }],
  }), [monthly])
  return <EChart option={option} height={200} />
}

function AssetCurve({
  daily, benchmark,
}: { daily: { date: string; asset: number; pnl_pct: number | null }[]; benchmark: { dates: string[]; closes: number[]; name?: string } | undefined }) {
  const option = useMemo(() => {
    const b0 = benchmark?.closes?.[0]
    return {
      animation: false,
      grid: { left: 60, right: 56, top: 28, bottom: 28 },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(30,30,36,0.95)', borderColor: '#3f3f46', textStyle: { color: '#e4e4e7', fontSize: 11 } },
      legend: { show: !!benchmark, top: 0, right: 0, textStyle: { fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
      xAxis: { type: 'category', data: daily.map(r => r.date.slice(5)), axisLabel: { fontSize: 9 } },
      yAxis: [
        { type: 'value', scale: true, axisLabel: { fontSize: 9, formatter: (v: number) => fmtMoney(v, 0) }, splitLine: { lineStyle: { color: 'rgba(128,128,140,0.15)' } } },
        { type: 'value', scale: true, axisLabel: { fontSize: 9, formatter: (v: number) => `${(v * 100).toFixed(0)}%` }, splitLine: { show: false } },
      ],
      series: [
        {
          name: '总资产', type: 'line', data: daily.map(r => r.asset), showSymbol: false,
          lineStyle: { width: 2, color: '#3b82f6' }, areaStyle: { color: 'rgba(59,130,246,0.12)' },
        },
        ...(benchmark && b0 ? [{
          name: benchmark.name || '基准', type: 'line', yAxisIndex: 1, showSymbol: false,
          data: daily.map(r => {
            const idx = benchmark.dates.indexOf(r.date)
            return idx >= 0 ? (benchmark.closes[idx] / b0 - 1) : null
          }),
          lineStyle: { width: 1.5, color: '#f59e0b', type: 'dashed' as const },
        }] : []),
      ],
    }
  }, [daily, benchmark])
  return <EChart option={option} height={220} />
}

function HoldingsPie({ rows }: { rows: HoldingRow[] }) {
  const option = useMemo(() => ({
    animation: false,
    tooltip: { trigger: 'item', valueFormatter: (v: number) => fmtMoney(v), backgroundColor: 'rgba(30,30,36,0.95)', borderColor: '#3f3f46', textStyle: { color: '#e4e4e7', fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['42%', '72%'], center: ['50%', '50%'],
      itemStyle: { borderRadius: 4, borderColor: 'rgba(0,0,0,0.25)', borderWidth: 1 },
      label: { fontSize: 10, formatter: '{b}\n{d}%' },
      data: rows.filter(r => r.market_value).map(r => ({ name: r.name || r.symbol, value: Math.round(r.market_value!) })),
    }],
  }), [rows])
  return <EChart option={option} height={220} />
}

/* ================================================================ * 持仓表 + 编辑/卖出
 * ================================================================ */

function EditDialog({ row, onClose }: { row: HoldingRow; onClose: () => void }) {
  const qc = useQueryClient()
  const [qty, setQty] = useState(String(row.qty))
  const [available, setAvailable] = useState(row.available != null ? String(row.available) : '')
  const [cost, setCost] = useState(row.avg_cost != null ? String(row.avg_cost) : '')
  const [sellPrice, setSellPrice] = useState(row.price != null ? String(row.price) : '')
  const [sellQty, setSellQty] = useState(String(row.qty))
  const [tab, setTab] = useState<'edit' | 'sell'>('edit')

  const save = useMutation({
    mutationFn: () => api.holdingsUpsert(row.symbol, {
      qty: Number(qty),
      available: available ? Number(available) : undefined,
      avg_cost: cost ? Number(cost) : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.holdings })
      qc.invalidateQueries({ queryKey: QK.holdingsSummary })
      qc.invalidateQueries({ queryKey: ['watchlist-enriched'] })
      toast('持仓已更新', 'success')
      onClose()
    },
  })
  const sell = useMutation({
    mutationFn: () => api.holdingsSell(row.symbol, Number(sellPrice), sellQty ? Number(sellQty) : undefined),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: QK.holdings })
      qc.invalidateQueries({ queryKey: QK.holdingsSummary })
      qc.invalidateQueries({ queryKey: ['watchlist-enriched'] })
      toast(`已卖出 · 实现盈亏 ${fmtMoney(res.realized_pnl)}`, res.realized_pnl >= 0 ? 'success' : 'error')
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative rounded-card border border-border bg-surface shadow-2xl px-5 py-4 w-[22rem] max-w-[92vw] space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">{row.name || row.symbol}</div>
          <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex gap-1 p-0.5 rounded-btn bg-elevated text-xs">
          {(['edit', 'sell'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-1.5 rounded-[inherit] transition-colors ${tab === t ? 'bg-surface text-foreground font-medium shadow-sm' : 'text-secondary'}`}>
              {t === 'edit' ? '编辑持仓' : '卖出'}
            </button>
          ))}
        </div>
        {tab === 'edit' ? (
          <div className="space-y-3">
            {([['持仓数量', qty, setQty], ['可用数量', available, setAvailable], ['成本价', cost, setCost]] as const).map(([label, v, set]) => (
              <label key={label} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-secondary">{label}</span>
                <input type="number" step="any" min="0" value={v} onChange={e => set(e.target.value)}
                  className="w-40 h-8 px-2.5 rounded-btn bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
              </label>
            ))}
            <button onClick={() => save.mutate()} disabled={save.isPending || !Number(qty)}
              className="w-full h-9 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-[11px] text-muted">卖出后记录已实现盈亏；全部卖出则清除自选/详情页的持仓标记。</div>
            {([['卖出价', sellPrice, setSellPrice], ['卖出数量', sellQty, setSellQty]] as const).map(([label, v, set]) => (
              <label key={label} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-secondary">{label}</span>
                <input type="number" step="any" min="0" value={v} onChange={e => set(e.target.value)}
                  className="w-40 h-8 px-2.5 rounded-btn bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
              </label>
            ))}
            {row.avg_cost != null && Number(sellPrice) && (
              <div className="text-[11px] text-muted tabular-nums">
                预计盈亏：<span className={pnlColor((Number(sellPrice) - row.avg_cost) * (Number(sellQty) || row.qty))}>
                  {fmtMoney((Number(sellPrice) - row.avg_cost) * (Number(sellQty) || row.qty))}
                </span>
              </div>
            )}
            <button onClick={() => sell.mutate()} disabled={sell.isPending || !Number(sellPrice)}
              className="w-full h-9 rounded-btn bg-[#ef4444]/90 text-white text-xs font-medium hover:bg-[#ef4444] disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
              {sell.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}确认卖出
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function PortfolioDialog({ initial, cash, onClose }: { initial: number; cash: number; onClose: () => void }) {
  const qc = useQueryClient()
  const [cap, setCap] = useState(initial ? String(initial) : '')
  const [c, setC] = useState(String(cash))
  const save = useMutation({
    mutationFn: () => api.holdingsPortfolio({ initial_cap: cap ? Number(cap) : undefined, cash: Number(c) || 0 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.holdingsSummary })
      qc.invalidateQueries({ queryKey: QK.holdingsPnl() })
      toast('资金已更新', 'success')
      onClose()
    },
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative rounded-card border border-border bg-surface shadow-2xl px-5 py-4 w-[22rem] max-w-[92vw] space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">资金设置</div>
          <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        {([['初始本金（计算总盈亏%）', cap, setCap], ['当前可用资金（现金）', c, setC]] as const).map(([label, v, set]) => (
          <label key={label} className="flex flex-col gap-1.5 text-xs">
            <span className="text-secondary">{label}</span>
            <input type="number" step="any" value={v} onChange={e => set(e.target.value)}
              className="h-9 px-2.5 rounded-btn bg-base border border-border tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
          </label>
        ))}
        <div className="text-[11px] text-muted">总资产 = 可用资金 + 持仓市值；日/月/年收益 = 总资产逐日变化。</div>
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="w-full h-9 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存
        </button>
      </div>
    </div>
  )
}

/* ================================================================
 * 主页面
 * ================================================================ */

export function Holdings() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'day' | 'month' | 'year'>('day')
  const [year, setYear] = useState(new Date().getFullYear())
  const [editing, setEditing] = useState<HoldingRow | null>(null)
  const [showPortfolio, setShowPortfolio] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

  const holdings = useQuery({ queryKey: QK.holdings, queryFn: () => api.holdingsList(), refetchInterval: 60_000 })
  const summary = useQuery({ queryKey: QK.holdingsSummary, queryFn: () => api.holdingsSummary(), refetchInterval: 60_000 })
  const pnl = useQuery({ queryKey: QK.holdingsPnl(`${year}-01-01`), queryFn: () => api.holdingsPnl(`${year}-01-01`), refetchInterval: 120_000 })
  const benchmark = useQuery({
    queryKey: ['holdings-benchmark', year],
    queryFn: () => api.holdingsBenchmark(`${year}-01-01`),
    enabled: tab === 'year',
  })

  const rows = holdings.data?.rows ?? []
  const s = summary.data
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: QK.holdings })
    qc.invalidateQueries({ queryKey: QK.holdingsSummary })
    qc.invalidateQueries({ queryKey: QK.holdingsPnl() })
  }

  const remove = useMutation({
    mutationFn: (symbol: string) => api.holdingsRemove(symbol),
    onSuccess: () => { refreshAll(); qc.invalidateQueries({ queryKey: ['watchlist-enriched'] }); toast('已删除持仓记录', 'success') },
  })

  const yearPnl = pnl.data?.yearly?.[0]?.pnl
  const monthPnl = pnl.data?.monthly?.[pnl.data.monthly.length - 1]?.pnl
  const todayPnl = pnl.data?.daily?.[pnl.data.daily.length - 1]?.pnl

  return (
    <div className="h-full flex flex-col">
      {/* 页头 */}
      <div className="px-4 md:px-6 py-3 border-b border-border flex items-center gap-3 flex-wrap shrink-0">
        <Briefcase className="h-5 w-5 text-accent" />
        <h1 className="text-base font-bold text-foreground">我的持仓</h1>
        <span className="text-xs text-muted">{rows.length} 只</span>
        <div className="flex-1" />
        <button onClick={refreshAll} className="p-1.5 rounded-btn text-secondary hover:text-foreground hover:bg-elevated" title="刷新"><RefreshCw className="h-4 w-4" /></button>
        <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90"><Plus className="h-3.5 w-3.5" />手动添加</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-4">
        {s && <SummaryCard s={s} onEditPortfolio={() => setShowPortfolio(true)} />}

        {/* 收益区 */}
        <div className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="flex items-center gap-1 p-0.5 rounded-btn bg-elevated text-xs">
              {([['day', '日收益'], ['month', '月收益'], ['year', '年收益']] as const).map(([t, label]) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 rounded-[inherit] transition-colors ${tab === t ? 'bg-surface text-foreground font-medium shadow-sm' : 'text-secondary hover:text-foreground'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <button onClick={() => setYear(y => y - 1)} className="px-1.5 text-secondary hover:text-foreground rotate-90"><ChevronDown className="h-4 w-4" /></button>
              <span className="tabular-nums font-semibold">{year} 年</span>
              <button onClick={() => setYear(y => y + 1)} className="px-1.5 text-secondary hover:text-foreground -rotate-90"><ChevronDown className="h-4 w-4" /></button>
              {tab === 'day' && <span className={`text-xs tabular-nums ${pnlColor(todayPnl)}`}>今日 {fmtMoney(todayPnl)}</span>}
              {tab === 'month' && <span className={`text-xs tabular-nums ${pnlColor(monthPnl)}`}>本月 {fmtMoney(monthPnl)}</span>}
              {tab === 'year' && <span className={`text-xs tabular-nums ${pnlColor(yearPnl)}`}>本年 {fmtMoney(yearPnl)}</span>}
            </div>
          </div>

          {pnl.isLoading ? (
            <div className="h-48 flex items-center justify-center text-xs text-muted"><Loader2 className="h-4 w-4 animate-spin mr-2" />收益计算中…</div>
          ) : tab === 'day' ? (
            <PnlCalendar daily={pnl.data?.daily ?? []} />
          ) : tab === 'month' ? (
            <MonthlyBars monthly={pnl.data?.monthly ?? []} />
          ) : (
            <AssetCurve daily={pnl.data?.daily ?? []} benchmark={benchmark.data} />
          )}
        </div>

        {/* 持仓明细 */}
        <div className="rounded-card border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold text-foreground">持仓明细</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted border-b border-border/60 bg-elevated/30">
                  {['名称/代码', '现价', '涨跌幅', '持仓/可用', '成本', '市值', '浮动盈亏', '当日盈亏', '操作'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const badge = REGION_BADGE[r.region ?? 'CN']
                  return (
                    <tr key={r.symbol} className="border-b border-border/40 hover:bg-elevated/30 transition-colors">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {badge && <span className={`px-1 py-px rounded text-[9px] font-bold border ${badge.cls}`}>{badge.label}</span>}
                          <span className="text-foreground font-medium">{r.name || '—'}</span>
                          <span className="font-mono text-muted">{r.symbol}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-foreground">{r.price?.toFixed(2) ?? '—'}</td>
                      <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.change_pct)}`}>{fmtPct(r.change_pct)}</td>
                      <td className="px-3 py-2.5 tabular-nums text-secondary">{r.qty}{r.available != null && r.available !== r.qty ? <span className="text-muted"> / {r.available}</span> : ''}</td>
                      <td className="px-3 py-2.5 tabular-nums text-secondary">{r.avg_cost?.toFixed(3) ?? '—'}</td>
                      <td className="px-3 py-2.5 tabular-nums text-foreground">{fmtMoney(r.market_value)}</td>
                      <td className={`px-3 py-2.5 tabular-nums font-medium ${pnlColor(r.float_pnl)}`}>
                        {fmtMoney(r.float_pnl)}<span className="text-[10px] font-normal ml-1">{fmtPct(r.float_pnl_pct)}</span>
                      </td>
                      <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.day_pnl)}`}>{fmtMoney(r.day_pnl)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <button onClick={() => setEditing(r)} className="p-1 rounded-btn text-secondary hover:text-accent hover:bg-elevated" title="编辑/卖出"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => remove.mutate(r.symbol)} className="p-1 rounded-btn text-secondary hover:text-danger hover:bg-elevated" title="删除记录"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-10 text-center text-muted text-xs">
                    暂无持仓 — 用自选页的「截图导入」勾选候选后选「导入到持仓」，或点右上角「手动添加」
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 持仓结构 + 盈亏贡献 */}
        {rows.length > 0 && (
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-card border border-border bg-surface p-4">
              <div className="flex items-center gap-2 mb-2"><PieIcon className="h-4 w-4 text-accent" /><span className="text-sm font-semibold text-foreground">持仓结构</span></div>
              <HoldingsPie rows={rows} />
            </div>
            <div className="rounded-card border border-border bg-surface p-4">
              <div className="flex items-center gap-2 mb-3"><TrendingUp className="h-4 w-4 text-accent" /><span className="text-sm font-semibold text-foreground">个股盈亏贡献</span></div>
              <div className="space-y-2">
                {(s?.contributions ?? []).map(c => {
                  const maxAbs = Math.max(1, ...(s?.contributions ?? []).map(x => Math.abs(x.float_pnl ?? 0)))
                  const w = Math.abs(c.float_pnl ?? 0) / maxAbs * 100
                  return (
                    <div key={c.symbol} className="flex items-center gap-2 text-xs">
                      <span className="w-20 truncate text-secondary text-right shrink-0">{c.name || c.symbol}</span>
                      <div className="flex-1 h-4 rounded bg-elevated/50 overflow-hidden flex justify-end">
                        <div className={`h-full rounded ${c.float_pnl! >= 0 ? 'bg-[#ef4444]/70' : 'bg-[#22c55e]/70'}`} style={{ width: `${w}%` }} />
                      </div>
                      <span className={`w-16 tabular-nums text-right shrink-0 ${pnlColor(c.float_pnl)}`}>{fmtMoney(c.float_pnl, 0)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {editing && <EditDialog row={editing} onClose={() => setEditing(null)} />}
      {showPortfolio && s && <PortfolioDialog initial={s.initial_cap} cash={s.cash} onClose={() => setShowPortfolio(false)} />}
      {showAdd && <AddDialog onClose={() => setShowAdd(false)} />}
    </div>
  )
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [symbol, setSymbol] = useState('')
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState('')
  const save = useMutation({
    mutationFn: () => api.holdingsUpsert(symbol.trim().toUpperCase(), {
      qty: Number(qty), avg_cost: cost ? Number(cost) : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.holdings })
      qc.invalidateQueries({ queryKey: QK.holdingsSummary })
      qc.invalidateQueries({ queryKey: ['watchlist-enriched'] })
      toast('持仓已添加', 'success')
      onClose()
    },
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative rounded-card border border-border bg-surface shadow-2xl px-5 py-4 w-[22rem] max-w-[92vw] space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">手动添加持仓</div>
          <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        {([['代码 (如 688825.SH / 00700.HK)', symbol, setSymbol], ['数量', qty, setQty], ['成本价', cost, setCost]] as const).map(([label, v, set]) => (
          <label key={label} className="flex flex-col gap-1.5 text-xs">
            <span className="text-secondary">{label}</span>
            <input value={v} onChange={e => set(e.target.value)}
              className={`h-9 px-2.5 rounded-btn bg-base border border-border text-foreground focus:outline-none focus:border-accent/50 ${label.startsWith('代码') ? 'font-mono' : 'tabular-nums text-right'}`} />
          </label>
        ))}
        <button onClick={() => save.mutate()} disabled={save.isPending || !symbol.trim() || !Number(qty)}
          className="w-full h-9 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}添加
        </button>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Briefcase, CalendarDays, Camera, ChevronDown, Loader2, Pencil, PieChart as PieIcon,
  Plus, RefreshCw, Sparkles, TrendingUp, Trash2, Wallet, X,
} from 'lucide-react'
import { api, type HoldingRow, type HoldingsSummary } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { toast } from '@/components/Toast'
import { StockPreviewDialog } from '@/components/StockPreviewDialog'
import { RecentPhotoStrip, type PickedImage } from '@/components/imports/RecentPhotoStrip'
import type { ECharts } from 'echarts'

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

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ================================================================
 * 迷你资产曲线 (svg sparkline)
 * ================================================================ */

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / range) * 26}`).join(' ')
  const up = values[values.length - 1] >= values[0]
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="w-28 h-7 ml-auto" aria-hidden>
      <polyline points={pts} fill="none" stroke={up ? '#ef4444' : '#22c55e'} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/* ================================================================
 * 汇总卡 (字体放大 + 金额/百分比红绿)
 * ================================================================ */

function SummaryCard({ s, spark, onEditPortfolio }: { s: HoldingsSummary; spark: number[]; onEditPortfolio: () => void }) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 md:p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs text-muted">总资产{ s.initial_cap ? <span className="ml-1">（本金 {fmtMoney(s.initial_cap, 0)}）</span> : null }</div>
          <div className="text-3xl md:text-4xl font-bold text-foreground tabular-nums mt-1.5 tracking-tight">{fmtMoney(s.total_asset)}</div>
        </div>
        <div className="flex items-center gap-3">
          {spark.length >= 2 && (
            <div className="text-right">
              <div className="text-[10px] text-muted mb-0.5">近30日</div>
              <Sparkline values={spark} />
            </div>
          )}
          <button
            onClick={onEditPortfolio}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground transition-colors"
          >
            <Wallet className="h-3.5 w-3.5" />资金设置
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5">
        <div>
          <div className="text-xs text-muted">当日盈亏</div>
          <div className={`text-lg font-bold tabular-nums mt-1 ${pnlColor(s.day_pnl)}`}>{fmtMoney(s.day_pnl)}</div>
          <div className={`text-sm tabular-nums ${pnlColor(s.day_pnl_pct)}`}>{fmtPct(s.day_pnl_pct)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">总盈亏（浮+已实现）</div>
          <div className={`text-lg font-bold tabular-nums mt-1 ${pnlColor(s.total_pnl)}`}>{fmtMoney(s.total_pnl)}</div>
          <div className={`text-sm tabular-nums ${pnlColor(s.total_pnl_pct)}`}>{fmtPct(s.total_pnl_pct)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">持仓市值 / 仓位</div>
          <div className="text-lg font-bold text-foreground tabular-nums mt-1">{fmtMoney(s.total_market_value)}</div>
          <div className="text-sm text-secondary tabular-nums">{s.position_pct != null ? `${(s.position_pct * 100).toFixed(1)}%` : '—'}</div>
        </div>
        <div>
          <div className="text-xs text-muted">可用资金 / 持仓数</div>
          <div className="text-lg font-bold text-foreground tabular-nums mt-1">{fmtMoney(s.cash)}</div>
          <div className="text-sm text-secondary tabular-nums">{s.positions} 只</div>
        </div>
      </div>
    </div>
  )
}

/* ================================================================
 * 收益日历热力图 (可点击某日看明细)
 * ================================================================ */

function PnlCalendar({ daily, onPickDay }: { daily: { date: string; pnl: number }[]; onPickDay: (d: string) => void }) {
  const [month, setMonth] = useState(() => {
    const last = daily[daily.length - 1]
    return last ? last.date.slice(0, 7) : new Date().toISOString().slice(0, 7)
  })

  const byDate = useMemo(() => new Map(daily.map(r => [r.date, r])), [daily])
  const monthDays = useMemo(() => daily.filter(r => r.date.startsWith(month)), [daily, month])
  const monthPnl = monthDays.reduce((a, r) => a + r.pnl, 0)

  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const gridStart = new Date(first)
  gridStart.setDate(1 - ((first.getDay() + 6) % 7))
  const cells: { date: string | null; pnl?: number }[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    cells.push(d.getMonth() === m - 1 ? { date: iso, pnl: byDate.get(iso)?.pnl } : { date: null })
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
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-foreground">{month.replace('-', ' 年 ')} 月</span>
          <span className={`text-xs tabular-nums font-medium ${pnlColor(monthPnl)}`}>{fmtMoney(monthPnl)}</span>
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
          <button
            key={i}
            disabled={!c.date || c.pnl == null}
            onClick={() => c.date && c.pnl != null && onPickDay(c.date)}
            title={c.date && c.pnl != null ? `${c.date} · ${fmtMoney(c.pnl)}（点击查看明细）` : ''}
            className={`aspect-square rounded-md flex flex-col items-center justify-center text-[10px] tabular-nums transition-transform
              ${c.date ? bg(c.pnl) : 'opacity-0'}
              ${c.pnl != null ? 'text-white font-medium hover:scale-105 cursor-pointer' : 'text-muted cursor-default'}`}
          >
            {c.date && <span className="opacity-70">{Number(c.date.slice(8))}</span>}
            {c.pnl != null && Math.abs(c.pnl) >= 1 && (
              <span className="text-[9px] leading-tight">{Math.abs(c.pnl) >= 1_0000 ? `${(c.pnl / 1_0000).toFixed(1)}万` : Math.round(c.pnl / (Math.abs(c.pnl) >= 1000 ? 1000 : 1)) + (Math.abs(c.pnl) >= 1000 ? 'k' : '')}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2 text-[10px] text-muted">
        <span>亏损</span>
        <div className="flex gap-0.5">
          {[0.5, 0.35, 0.2].map(t => <span key={t} className="w-4 h-2 rounded-sm" style={{ background: `rgba(34,197,94,${t})` }} />)}
          <span className="w-4 h-2 rounded-sm bg-elevated/40" />
          {[0.2, 0.35, 0.5].map(t => <span key={t} className="w-4 h-2 rounded-sm" style={{ background: `rgba(239,68,68,${t})` }} />)}
        </div>
        <span>盈利 · 点击日期看明细</span>
      </div>
    </div>
  )
}

/* ================================================================
 * ECharts 通用封装 + 月柱图 / 资产曲线 / 饼图
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

const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(30,30,36,0.95)', borderColor: '#3f3f46', textStyle: { color: '#e4e4e7', fontSize: 11 },
}

function MonthlyBars({ monthly }: { monthly: { period: string; pnl: number }[] }) {
  const option = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 20, top: 26, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => fmtMoney(v), ...TOOLTIP_STYLE },
    xAxis: { type: 'category', data: monthly.map(r => `${Number(r.period.slice(5))}月`), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: (v: number) => fmtMoney(v, 0) }, splitLine: { lineStyle: { color: 'rgba(128,128,140,0.15)' } } },
    series: [{
      type: 'bar', barMaxWidth: 28,
      data: monthly.map(r => ({
        value: r.pnl,
        itemStyle: { color: r.pnl >= 0 ? '#ef4444' : '#22c55e', borderRadius: [3, 3, 0, 0] },
      })),
      label: { show: true, position: 'top', fontSize: 9, color: '#a1a1aa', formatter: (p: any) => (Math.abs(p.value) >= 100 ? fmtMoney(p.value, 0) : '') },
    }],
  }), [monthly])
  return <EChart option={option} height={200} />
}

function AssetCurve({ daily, benchmark }: { daily: { date: string; asset: number }[]; benchmark: { dates: string[]; closes: number[]; name?: string } | undefined }) {
  const option = useMemo(() => {
    const b0 = benchmark?.closes?.[0]
    return {
      animation: false,
      grid: { left: 60, right: 56, top: 28, bottom: 28 },
      tooltip: { trigger: 'axis', ...TOOLTIP_STYLE },
      legend: { show: !!benchmark, top: 0, right: 0, textStyle: { fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
      xAxis: { type: 'category', data: daily.map(r => r.date.slice(5)), axisLabel: { fontSize: 9 } },
      yAxis: [
        { type: 'value', scale: true, axisLabel: { fontSize: 9, formatter: (v: number) => fmtMoney(v, 0) }, splitLine: { lineStyle: { color: 'rgba(128,128,140,0.15)' } } },
        { type: 'value', scale: true, axisLabel: { fontSize: 9, formatter: (v: number) => `${(v * 100).toFixed(0)}%` }, splitLine: { show: false } },
      ],
      series: [
        { name: '总资产', type: 'line', data: daily.map(r => r.asset), showSymbol: false, lineStyle: { width: 2, color: '#3b82f6' }, areaStyle: { color: 'rgba(59,130,246,0.12)' } },
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
    tooltip: { trigger: 'item', valueFormatter: (v: number) => fmtMoney(v), ...TOOLTIP_STYLE },
    series: [{
      type: 'pie', radius: ['42%', '72%'],
      itemStyle: { borderRadius: 4, borderColor: 'rgba(0,0,0,0.25)', borderWidth: 1 },
      label: { fontSize: 10, formatter: '{b}\n{d}%' },
      data: rows.filter(r => r.market_value).map(r => ({ name: r.name || r.symbol, value: Math.round(r.market_value!) })),
    }],
  }), [rows])
  return <EChart option={option} height={220} />
}

/* ================================================================
 * 编辑/卖出 / 资金设置 / 手动添加
 * ================================================================ */

function EditDialog({ row, onClose }: { row: HoldingRow; onClose: () => void }) {
  const qc = useQueryClient()
  const [qty, setQty] = useState(String(row.qty))
  const [available, setAvailable] = useState(row.available != null ? String(row.available) : '')
  const [cost, setCost] = useState(row.avg_cost != null ? String(row.avg_cost) : '')
  const [sellPrice, setSellPrice] = useState(row.price != null ? String(row.price) : '')
  const [sellQty, setSellQty] = useState(String(row.qty))
  const [tab, setTab] = useState<'edit' | 'sell'>('edit')
  const [fetchingPrice, setFetchingPrice] = useState(false)

  const refreshPrice = async () => {
    setFetchingPrice(true)
    try {
      const latest = await api.holdingsList()
      const hit = latest.rows.find(r => r.symbol === row.symbol)
      if (hit?.price != null) setSellPrice(String(hit.price))
      else toast('未取到实时价', 'error')
    } finally {
      setFetchingPrice(false)
    }
  }

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
      <div className="relative rounded-card border border-border bg-surface shadow-2xl px-5 py-4 w-[23rem] max-w-[92vw] space-y-4">
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
            <label className="flex items-center justify-between gap-3 text-xs">
              <span className="text-secondary">卖出价</span>
              <span className="flex items-center gap-1.5">
                <button onClick={refreshPrice} disabled={fetchingPrice}
                  className="px-1.5 py-1 rounded-btn bg-elevated text-[10px] text-secondary hover:text-accent inline-flex items-center gap-1" title="一键取实时价">
                  {fetchingPrice ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}实时
                </button>
                <input type="number" step="any" min="0" value={sellPrice} onChange={e => setSellPrice(e.target.value)}
                  className="w-32 h-8 px-2.5 rounded-btn bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
              </span>
            </label>
            <label className="flex items-center justify-between gap-3 text-xs">
              <span className="text-secondary">卖出数量</span>
              <input type="number" step="any" min="0" value={sellQty} onChange={e => setSellQty(e.target.value)}
                className="w-40 h-8 px-2.5 rounded-btn bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
            </label>
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
      <div className="relative rounded-card border border-border bg-surface shadow-2xl px-5 py-4 w-[23rem] max-w-[92vw] space-y-4">
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
      <div className="relative rounded-card border border-border bg-surface shadow-2xl px-5 py-4 w-[23rem] max-w-[92vw] space-y-4">
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

/* ================================================================
 * 截图导入 (识别 → 年/月/日级联日期选择 → 导入)
 * ================================================================ */

function HoldingsImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [queue, setQueue] = useState<PickedImage[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [provider, setProvider] = useState('')

  interface Row { symbol: string; name: string; market: string; qty: string; available: string; cost: string; verified?: boolean | null }
  interface ImageResult { img: PickedImage; url: string; rows: Row[] }

  const [results, setResults] = useState<ImageResult[]>([])
  const [phase, setPhase] = useState<'pick' | 'confirm' | 'summary'>('pick')
  const [confirmIdx, setConfirmIdx] = useState(0)
  const [curRows, setCurRows] = useState<Row[]>([])
  const [curChecked, setCurChecked] = useState<Set<string>>(new Set())
  const [acceptedRows, setAcceptedRows] = useState<Row[]>([])

  const [summaryRows, setSummaryRows] = useState<Row[]>([])
  const [summaryChecked, setSummaryChecked] = useState<Set<string>>(new Set())
  const [importDate, setImportDate] = useState(todayIso())
  const [cash, setCash] = useState('')

  const isToday = importDate === todayIso()

  // 关闭时释放预览 URL
  useEffect(() => () => {
    results.forEach(r => URL.revokeObjectURL(r.url))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addImages = (imgs: PickedImage[]) => {
    setQueue(prev => {
      const seen = new Set(prev.map(i => i.key))
      const merged = [...prev]
      for (const im of imgs) {
        if (!seen.has(im.key)) { merged.push(im); seen.add(im.key) }
      }
      return merged
    })
  }

  const recognizeAll = async () => {
    if (queue.length === 0) { toast('请先选择截图', 'error'); return }
    setBusy(true)
    const out: ImageResult[] = []
    let latestDate = ''
    let totalRows = 0
    for (let i = 0; i < queue.length; i++) {
      setProgress(`识别中 ${i + 1}/${queue.length}…`)
      const url = URL.createObjectURL(queue[i].file)
      const rows: Row[] = []
      try {
        const res = await api.watchlistImportImage(queue[i].file, undefined, true)
        setProvider(res.provider)
        for (const c of res.candidates) {
          if (!c.matched || !c.symbol) continue
          rows.push({
            symbol: c.symbol,
            name: c.name || c.symbol,
            market: c.market || 'CN',
            qty: c.qty != null ? String(c.qty) : '',
            available: c.available != null ? String(c.available) : '',
            cost: c.cost != null ? String(c.cost) : '',
            verified: c.verified ?? null,
          })
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : `第 ${i + 1} 张识别失败`, 'error')
      }
      totalRows += rows.length
      out.push({ img: queue[i], url, rows })
      if (queue[i].date > latestDate) latestDate = queue[i].date
    }
    setProgress('')
    setBusy(false)
    setResults(out)
    if (totalRows === 0) {
      toast('未识别到持仓记录，请换更清晰的截图', 'error')
      out.forEach(r => URL.revokeObjectURL(r.url))
      return
    }
    if (latestDate) setImportDate(latestDate)
    // 进入第一张的确认
    setConfirmIdx(0)
    setCurRows(out[0].rows)
    setCurChecked(new Set(out[0].rows.map(r => r.symbol)))
    setPhase('confirm')
  }

  const cur = phase === 'confirm' ? results[confirmIdx] : null

  const updateCur = (symbol: string, patch: Partial<Row>) =>
    setCurRows(prev => prev.map(r => (r.symbol === symbol ? { ...r, ...patch } : r)))
  const toggleCur = (symbol: string) =>
    setCurChecked(prev => {
      const next = new Set(prev)
      if (next.has(symbol)) next.delete(symbol)
      else next.add(symbol)
      return next
    })

  const acceptCurrent = () => {
    if (!cur) return
    const kept = curRows.filter(r => curChecked.has(r.symbol) && r.symbol && Number(r.qty) >= 0)
    setAcceptedRows(prev => [...prev, ...kept])
  }

  const goNext = () => {
    acceptCurrent()
    const next = confirmIdx + 1
    if (next < results.length) {
      setConfirmIdx(next)
      setCurRows(results[next].rows)
      setCurChecked(new Set(results[next].rows.map(r => r.symbol)))
    } else {
      enterSummary()
    }
  }

  const enterSummary = () => {
    // 汇总去重: 同 symbol 保留数量大的
    const bySymbol = new Map<string, Row>()
    for (const r of acceptedRows) {
      const prev = bySymbol.get(r.symbol)
      if (!prev || (Number(r.qty) || 0) > (Number(prev.qty) || 0)) bySymbol.set(r.symbol, r)
    }
    const merged = [...bySymbol.values()]
    setSummaryRows(merged)
    setSummaryChecked(new Set(merged.filter(r => Number(r.qty) > 0).map(r => r.symbol)))
    setPhase('summary')
  }

  const updateSummary = (symbol: string, patch: Partial<Row>) =>
    setSummaryRows(prev => prev.map(r => (r.symbol === symbol ? { ...r, ...patch } : r)))
  const toggleSummary = (symbol: string) =>
    setSummaryChecked(prev => {
      const next = new Set(prev)
      if (next.has(symbol)) next.delete(symbol)
      else next.add(symbol)
      return next
    })

  const doImport = useMutation({
    mutationFn: () => api.holdingsImport(
      summaryRows
        .filter(r => summaryChecked.has(r.symbol) && r.symbol && Number(r.qty) > 0)
        .map(r => ({
          symbol: r.symbol,
          qty: Number(r.qty),
          available: r.available ? Number(r.available) : undefined,
          cost: r.cost ? Number(r.cost) : undefined,
        })),
      importDate,
      cash ? Number(cash) : undefined,
    ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: QK.holdings })
      qc.invalidateQueries({ queryKey: QK.holdingsSummary })
      qc.invalidateQueries({ queryKey: QK.holdingsPnl() })
      qc.invalidateQueries({ queryKey: QK.watchlist })
      qc.invalidateQueries({ queryKey: ['watchlist-enriched'] })
      toast(res.snapshot ? `已存入 ${res.date} 历史快照` : '持仓已更新（今日）', 'success')
      onClose()
    },
  })

  const curSelected = curRows.filter(r => curChecked.has(r.symbol) && r.symbol).length
  const summarySelected = summaryRows.filter(r => summaryChecked.has(r.symbol) && r.symbol && Number(r.qty) > 0).length

  /* 通用行编辑区 */
  const renderRows = (
    rows: Row[], checked: Set<string>,
    onToggle: (s: string) => void, onUpdate: (s: string, p: Partial<Row>) => void,
    onRemove: (s: string) => void,
  ) => (
    <div className="space-y-1.5">
      {rows.map(r => (
        <div key={r.symbol} className={`flex items-center gap-1.5 text-xs rounded-btn border px-2 py-1.5 ${checked.has(r.symbol) ? 'border-border bg-elevated/40' : 'border-border/40 opacity-50'}`}>
          <input type="checkbox" checked={checked.has(r.symbol)} onChange={() => onToggle(r.symbol)} className="rounded border-border shrink-0" />
          <span className="w-20 shrink-0 truncate font-medium text-foreground" title={`${r.name} ${r.symbol}`}>
            {r.name}
            {r.verified != null && (
              <span className={`ml-0.5 text-[10px] ${r.verified ? 'text-emerald-400' : 'text-amber-400'}`}>{r.verified ? '✓' : '⚠'}</span>
            )}
          </span>
          <input type="number" step="any" value={r.qty} placeholder="数量" onChange={e => onUpdate(r.symbol, { qty: e.target.value })}
            className="w-14 px-1.5 h-7 rounded bg-base border border-border text-right tabular-nums focus:outline-none focus:border-accent/50" />
          <input type="number" step="any" value={r.available} placeholder="可用" onChange={e => onUpdate(r.symbol, { available: e.target.value })}
            className="w-14 px-1.5 h-7 rounded bg-base border border-border text-right tabular-nums focus:outline-none focus:border-accent/50" />
          <input type="number" step="any" value={r.cost} placeholder="成本" onChange={e => onUpdate(r.symbol, { cost: e.target.value })}
            className="w-18 px-1.5 h-7 rounded bg-base border border-border text-right tabular-nums focus:outline-none focus:border-accent/50" />
          <button onClick={() => onRemove(r.symbol)} className="p-1 rounded-btn text-secondary hover:text-danger shrink-0" title="移除"><X className="h-3.5 w-3.5" /></button>
        </div>
      ))}
      <button
        onClick={() => {
          const sym = window.prompt('输入代码 (如 688825.SH / 00700.HK)')
          if (!sym) return
          const s = sym.trim().toUpperCase()
          if (rows.some(r => r.symbol === s)) { toast('该代码已在列表', 'error'); return }
          const row: Row = { symbol: s, name: s, market: 'CN', qty: '', available: '', cost: '' }
          if (phase === 'summary') { setSummaryRows(prev => [...prev, row]); setSummaryChecked(prev => new Set([...prev, s])) }
          else { setCurRows(prev => [...prev, row]); setCurChecked(prev => new Set([...prev, s])) }
        }}
        className="w-full py-1.5 rounded-btn border border-dashed border-border text-[11px] text-muted hover:text-secondary hover:border-accent/40"
      >+ 添加持仓</button>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative rounded-card border border-border bg-surface shadow-2xl flex flex-col max-h-[90vh]
        ${phase === 'confirm' ? 'w-[62rem] max-w-[96vw]' : 'w-[34rem] max-w-[94vw]'}`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="text-sm font-semibold text-foreground">
            截图导入持仓
            {phase === 'confirm' && <span className="ml-2 text-xs text-muted font-normal">第 {confirmIdx + 1}/{results.length} 张 · 请核对右侧识别结果</span>}
            {phase === 'summary' && <span className="ml-2 text-xs text-muted font-normal">汇总确认 · 共 {summaryRows.length} 条</span>}
          </div>
          <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>

        {/* 选图阶段 */}
        {phase === 'pick' && (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <RecentPhotoStrip layout="grid" pickedKeys={new Set(queue.map(q => q.key))} onPick={im => addImages([im])} />
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={e => {
                const files = Array.from(e.target.files ?? [])
                addImages(files.map(f => ({
                  file: f,
                  date: f.lastModified ? new Date(f.lastModified).toISOString().slice(0, 10) : todayIso(),
                  key: `file:${f.name}:${f.lastModified}`,
                })))
                e.target.value = ''
              }}
            />
            <button onClick={() => inputRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 rounded-btn border border-dashed border-border bg-elevated/40 hover:bg-elevated/70 px-4 py-3 text-xs text-secondary">
              <Camera className="h-4 w-4 text-accent" />或从文件夹选择（支持多选）
            </button>

            {queue.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] text-secondary">已选 {queue.length} 张{provider ? ` · 引擎 ${provider}` : ''}（点缩略图 ✕ 移除）</div>
                <div className="grid grid-cols-5 gap-2.5">
                  {queue.map(q => (
                    <div key={q.key} className="relative h-28 rounded-btn overflow-hidden border border-accent/60">
                      <img src={URL.createObjectURL(q.file)} alt={q.file.name} className="w-full h-full object-cover" />
                      <button
                        onClick={() => setQueue(prev => prev.filter(x => x.key !== q.key))}
                        className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white"
                      ><X className="h-3 w-3" /></button>
                    </div>
                  ))}
                </div>
                <button onClick={recognizeAll} disabled={busy}
                  className="w-full h-9 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {busy ? progress : `开始识别（${queue.length} 张）`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 逐张确认: 左预览图 (等高居中) + 右识别结果 */}
        {phase === 'confirm' && cur && (
          <div className="flex-1 flex min-h-0">
            <div className="flex-1 min-w-0 bg-black/30 flex items-center justify-center p-3">
              <img src={cur.url} alt={cur.img.file.name} className="max-w-full max-h-full object-contain rounded" />
            </div>
            <div className="w-[25rem] shrink-0 border-l border-border overflow-y-auto px-4 py-3 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-secondary">识别 {cur.rows.length} 条 · 勾选 {curSelected} 条</span>
                <span className="text-muted">{cur.img.date}</span>
              </div>
              {renderRows(curRows, curChecked, toggleCur, updateCur, s => setCurRows(prev => prev.filter(x => x.symbol !== s)))}
              <div className="pt-1 space-y-2 border-t border-border/60">
                <button onClick={goNext}
                  className="w-full h-9 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90 inline-flex items-center justify-center gap-1.5">
                  {confirmIdx + 1 < results.length
                    ? `确认本张，下一张（${confirmIdx + 2}/${results.length}）`
                    : `全部确认，进入汇总（${results.length} 张）`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 汇总确认 */}
        {phase === 'summary' && (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-secondary">来自 {results.length} 张截图 · 去重后 {summaryRows.length} 条 · 勾选 {summarySelected} 条</span>
              <button onClick={() => { setPhase('pick'); acceptedRows.forEach(() => {}); setResults(r => { r.forEach(x => URL.revokeObjectURL(x.url)); return [] }); setAcceptedRows([]); setConfirmIdx(0) }}
                className="text-[11px] text-accent hover:underline">重新选图</button>
            </div>
            {renderRows(summaryRows, summaryChecked, toggleSummary, updateSummary, s => setSummaryRows(prev => prev.filter(x => x.symbol !== s)))}
            <div className="pt-1 space-y-2 border-t border-border/60">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-secondary shrink-0">导入日期</span>
                <input type="date" value={importDate} max={todayIso()} onChange={e => setImportDate(e.target.value)}
                  className="flex-1 h-8 px-2 rounded-btn bg-base border border-border tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
              </div>
              {!isToday && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-secondary shrink-0">当日现金</span>
                  <input type="number" step="any" value={cash} onChange={e => setCash(e.target.value)} placeholder="可选，用于分段回算"
                    className="flex-1 h-8 px-2 rounded-btn bg-base border border-border tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
                </div>
              )}
              <div className="text-[11px] text-muted rounded-btn bg-elevated/40 px-3 py-1.5">
                {isToday ? '今日截图 → 直接更新当前持仓' : `${importDate}（历史）→ 存为该日快照，收益按快照分段回算`}
              </div>
              <button
                disabled={summarySelected === 0 || doImport.isPending}
                onClick={() => doImport.mutate()}
                className="w-full h-9 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
              >
                {doImport.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isToday ? `确认导入持仓（${summarySelected}）` : `存入 ${importDate} 快照（${summarySelected}）`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
/* ================================================================
 * 当日盈亏明细弹窗 (日历点击)
 * ================================================================ */

function DayDetailDialog({ day, onClose }: { day: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['holdings-pnl-day', day],
    queryFn: () => api.holdingsPnlDay(day),
    staleTime: 5 * 60_000,
  })
  const total = q.data?.total ?? 0
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative rounded-card border border-border bg-surface shadow-2xl w-[23rem] max-w-[92vw] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-sm font-semibold text-foreground">
            {day} 当日盈亏明细
          </div>
          <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-3 border-b border-border/60 flex items-baseline gap-3">
          <span className={`text-xl font-bold tabular-nums ${pnlColor(total)}`}>{fmtMoney(total)}</span>
          <span className="text-xs text-muted">{q.data?.rows.length ?? 0} 只持仓</span>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-2">
          {q.isLoading ? (
            <div className="py-8 text-center text-xs text-muted"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…</div>
          ) : (q.data?.rows ?? []).map(r => (
            <div key={r.symbol} className="flex items-center gap-2 py-2 border-b border-border/40 text-xs last:border-0">
              <span className="flex-1 min-w-0 truncate">
                <span className="text-foreground">{r.name || r.symbol}</span>
                <span className="text-muted ml-1.5">{r.qty}股</span>
              </span>
              <span className="tabular-nums text-secondary">{r.close?.toFixed(2)}</span>
              <span className={`w-16 text-right tabular-nums font-medium ${pnlColor(r.pnl_pct)}`}>{fmtPct(r.pnl_pct)}</span>
              <span className={`w-20 text-right tabular-nums font-semibold ${pnlColor(r.pnl)}`}>{fmtMoney(r.pnl)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ================================================================
 * AI 组合体检
 * ================================================================ */

function renderMd(text: string): React.ReactNode[] {
  // 轻量 markdown: ## 标题 / **粗体** / - 列表; 剥离模型可能包裹的代码围栏
  const cleaned = text.replace(/^\s*```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  return cleaned.split('\n').map((line, i) => {
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const size = ['text-base', 'text-sm', 'text-xs', 'text-xs'][h[1].length - 1]
      return <div key={i} className={`${size} font-bold text-foreground mt-3 mb-1.5`}>{h[2]}</div>
    }
    if (line.trim().startsWith('- ')) {
      return <div key={i} className="text-xs text-secondary pl-3 py-0.5">• {line.trim().slice(2).replace(/\*\*(.+?)\*\*/g, '$1')}</div>
    }
    if (!line.trim()) return <div key={i} className="h-2" />
    return <div key={i} className="text-xs text-secondary leading-relaxed">{line.replace(/\*\*(.+?)\*\*/g, '$1')}</div>
  })
}

function AiReportPanel({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'running' | 'done' | 'error'>('running')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        for await (const chunk of api.holdingsAnalyzeStream()) {
          if (cancelled) return
          if (chunk.type === 'delta' && chunk.content) setText(t => t + chunk.content)
          if (chunk.type === 'error') { setStatus('error'); toast(chunk.message || 'AI 分析失败', 'error'); return }
          if (chunk.type === 'done') { setStatus('done'); return }
        }
        setStatus('done')
      } catch {
        if (!cancelled) setStatus('error')
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [text])

  return (
    <div className="rounded-card border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-400" />
        <span className="text-sm font-semibold text-foreground">AI 组合体检</span>
        {status === 'running' && <span className="text-[11px] text-accent inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />分析中…</span>}
        {status === 'error' && <span className="text-[11px] text-danger">失败</span>}
        <div className="flex-1" />
        <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
      </div>
      <div ref={boxRef} className="px-4 py-3 max-h-96 overflow-y-auto">
        {text ? renderMd(text) : status === 'running' ? (
          <div className="text-xs text-muted py-4 text-center">正在读取持仓与近期行情，生成体检报告…</div>
        ) : null}
      </div>
    </div>
  )
}

/* ================================================================
 * 主页面
 * ================================================================ */

type SortKey = 'name' | 'price' | 'change_pct' | 'qty' | 'avg_cost' | 'market_value' | 'float_pnl' | 'day_pnl'

export function Holdings() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'day' | 'month' | 'year'>('day')
  const [year, setYear] = useState(new Date().getFullYear())
  const [editing, setEditing] = useState<HoldingRow | null>(null)
  const [showPortfolio, setShowPortfolio] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [dayDetail, setDayDetail] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  const [aiKey, setAiKey] = useState(0)
  const [previewSymbol, setPreviewSymbol] = useState<string | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('market_value')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const holdings = useQuery({
    queryKey: QK.holdings, queryFn: () => api.holdingsList(),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  })
  const summary = useQuery({
    queryKey: QK.holdingsSummary, queryFn: () => api.holdingsSummary(),
    refetchInterval: 15_000, refetchOnWindowFocus: true,
  })
  const pnl = useQuery({
    queryKey: QK.holdingsPnl(`${year}-01-01`), queryFn: () => api.holdingsPnl(`${year}-01-01`),
    refetchInterval: 120_000,
  })
  const benchmark = useQuery({
    queryKey: ['holdings-benchmark', year],
    queryFn: () => api.holdingsBenchmark(`${year}-01-01`),
    enabled: tab === 'year',
  })

  const rows = useMemo(() => {
    const list = [...(holdings.data?.rows ?? [])]
    const val = (r: HoldingRow) => {
      switch (sortKey) {
        case 'name': return r.name || r.symbol
        case 'price': return r.price ?? -Infinity
        case 'change_pct': return r.change_pct ?? -Infinity
        case 'qty': return r.qty
        case 'avg_cost': return r.avg_cost ?? -Infinity
        case 'market_value': return r.market_value ?? -Infinity
        case 'float_pnl': return r.float_pnl ?? -Infinity
        case 'day_pnl': return r.day_pnl ?? -Infinity
      }
    }
    list.sort((a, b) => {
      const va = val(a), vb = val(b)
      const cmp = typeof va === 'string' ? String(va).localeCompare(String(vb)) : (Number(va) - Number(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return list
  }, [holdings.data, sortKey, sortDir])

  const s = summary.data
  const spark = (pnl.data?.daily ?? []).slice(-30).map(r => r.asset)

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

  const sortHeaders: { key: SortKey; label: string }[] = [
    { key: 'name', label: '名称/代码' },
    { key: 'price', label: '现价' },
    { key: 'change_pct', label: '涨跌幅' },
    { key: 'qty', label: '持仓/可用' },
    { key: 'avg_cost', label: '成本' },
    { key: 'market_value', label: '市值' },
    { key: 'float_pnl', label: '浮动盈亏' },
    { key: 'day_pnl', label: '当日盈亏' },
  ]
  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc') }
  }

  return (
    <div className="h-full flex flex-col">
      {/* 页头 */}
      <div className="px-4 md:px-6 py-3 border-b border-border flex items-center gap-3 flex-wrap shrink-0">
        <Briefcase className="h-5 w-5 text-accent" />
        <h1 className="text-base font-bold text-foreground">我的持仓</h1>
        <span className="text-xs text-muted">{rows.length} 只</span>
        <div className="flex-1" />
        <button
          onClick={() => { setShowAi(true); setAiKey(k => k + 1) }}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-btn border border-violet-500/40 bg-violet-500/10 text-violet-400 text-xs font-medium hover:bg-violet-500/20"
        >
          <Sparkles className="h-3.5 w-3.5" />AI 分析
        </button>
        <button onClick={refreshAll} className="p-1.5 rounded-btn text-secondary hover:text-foreground hover:bg-elevated" title="刷新"><RefreshCw className="h-4 w-4" /></button>
        <button onClick={() => setShowImport(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground border border-border"><Camera className="h-3.5 w-3.5" />截图导入</button>
        <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90"><Plus className="h-3.5 w-3.5" />手动添加</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-4">
        {s && <SummaryCard s={s} spark={spark} onEditPortfolio={() => setShowPortfolio(true)} />}

        {showAi && <AiReportPanel key={aiKey} onClose={() => setShowAi(false)} />}

        {/* 持仓明细 (可排序 + 点击查看) */}
        <div className="rounded-card border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold text-foreground">持仓明细</span>
            <span className="text-[10px] text-muted">点列名排序 · 点行查看个股</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-muted border-b border-border/60 bg-elevated/30">
                  {sortHeaders.map(h => (
                    <th key={h.key} onClick={() => toggleSort(h.key)}
                      className="px-3 py-2.5 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:text-foreground">
                      {h.label}
                      {sortKey === h.key && <span className="ml-0.5 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const badge = REGION_BADGE[r.region ?? 'CN']
                  return (
                    <tr key={r.symbol} className="border-b border-border/40 hover:bg-elevated/30 transition-colors cursor-pointer"
                      onClick={() => { setPreviewSymbol(r.symbol); setPreviewName(r.name || '') }}>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {badge && <span className={`px-1 py-px rounded text-[9px] font-bold border ${badge.cls}`}>{badge.label}</span>}
                          <span className="text-foreground font-medium">{r.name || '—'}</span>
                          <span className="font-mono text-muted text-xs">{r.symbol}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-foreground">{r.price?.toFixed(2) ?? '—'}</td>
                      <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.change_pct)}`}>{fmtPct(r.change_pct)}</td>
                      <td className="px-3 py-2.5 tabular-nums text-secondary">{r.qty}{r.available != null && r.available !== r.qty ? <span className="text-muted"> / {r.available}</span> : ''}</td>
                      <td className="px-3 py-2.5 tabular-nums text-secondary">{r.avg_cost?.toFixed(3) ?? '—'}</td>
                      <td className="px-3 py-2.5 tabular-nums text-foreground">{fmtMoney(r.market_value)}</td>
                      <td className={`px-3 py-2.5 tabular-nums font-semibold ${pnlColor(r.float_pnl)}`}>
                        {fmtMoney(r.float_pnl)}<span className="text-[11px] font-normal ml-1">{fmtPct(r.float_pnl_pct)}</span>
                      </td>
                      <td className={`px-3 py-2.5 tabular-nums font-semibold ${pnlColor(r.day_pnl)}`}>{fmtMoney(r.day_pnl)}</td>
                      <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setEditing(r)} className="p-1 rounded-btn text-secondary hover:text-accent hover:bg-elevated" title="编辑/卖出"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => remove.mutate(r.symbol)} className="p-1 rounded-btn text-secondary hover:text-danger hover:bg-elevated" title="删除记录"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-12 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="text-sm text-foreground font-medium">暂无当日持仓</div>
                      <div className="text-xs text-muted leading-relaxed">
                        持仓明细仅显示当日持仓。<br />
                        导入当日持仓截图以便于进行核查同步；如需补历史记录，导入时可选择历史日期。
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setShowImport(true)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90"
                        >
                          <Camera className="h-3.5 w-3.5" />导入当日持仓截图
                        </button>
                        <button
                          onClick={() => setShowAdd(true)}
                          className="px-3.5 py-2 rounded-btn bg-elevated text-secondary text-xs hover:text-foreground"
                        >手动添加</button>
                      </div>
                    </div>
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

        {/* 日/月/年收益 (置于最下) */}
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
              {tab === 'day' && <span className={`text-xs tabular-nums font-medium ${pnlColor(todayPnl)}`}>今日 {fmtMoney(todayPnl)}</span>}
              {tab === 'month' && <span className={`text-xs tabular-nums font-medium ${pnlColor(monthPnl)}`}>本月 {fmtMoney(monthPnl)}</span>}
              {tab === 'year' && <span className={`text-xs tabular-nums font-medium ${pnlColor(yearPnl)}`}>本年 {fmtMoney(yearPnl)}</span>}
            </div>
          </div>

          {pnl.isLoading ? (
            <div className="h-48 flex items-center justify-center text-xs text-muted"><Loader2 className="h-4 w-4 animate-spin mr-2" />收益计算中…</div>
          ) : tab === 'day' ? (
            <PnlCalendar daily={pnl.data?.daily ?? []} onPickDay={setDayDetail} />
          ) : tab === 'month' ? (
            <MonthlyBars monthly={pnl.data?.monthly ?? []} />
          ) : (
            <AssetCurve daily={pnl.data?.daily ?? []} benchmark={benchmark.data} />
          )}
        </div>
      </div>

      {editing && <EditDialog row={editing} onClose={() => setEditing(null)} />}
      {showPortfolio && s && <PortfolioDialog initial={s.initial_cap} cash={s.cash} onClose={() => setShowPortfolio(false)} />}
      {showAdd && <AddDialog onClose={() => setShowAdd(false)} />}
      {showImport && <HoldingsImportDialog onClose={() => setShowImport(false)} />}
      {dayDetail && <DayDetailDialog day={dayDetail} onClose={() => setDayDetail(null)} />}
      {previewSymbol && (
        <StockPreviewDialog
          symbol={previewSymbol}
          name={previewName}
          triggerInfo={undefined}
          onClose={() => setPreviewSymbol(null)}
        />
      )}
    </div>
  )
}

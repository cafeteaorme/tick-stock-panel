import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookMarked, Briefcase, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Loader2, Pencil, PieChart as PieIcon,
  Plus, RefreshCw, Settings as SettingsIcon, Sparkles, TrendingUp, Trash2, X,
} from 'lucide-react'
import { api, type HoldingRow, type HoldingsSummary } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { toast } from '@/components/Toast'
import { StockPreviewDialog } from '@/components/StockPreviewDialog'
import { RecentPhotoStrip, type PickedImage } from '@/components/imports/RecentPhotoStrip'

/** 截图汇总区 (AI 识别) */
interface ShotSummary {
  total_asset?: number | null
  total_pnl?: number | null
  day_pnl?: number | null
  day_pnl_pct?: number | null
  market_value?: number | null
  cash_available?: number | null
  cash_withdrawable?: number | null
  position_pct?: number | null
}
import type { ECharts } from 'echarts'

/* ================================================================
 * 工具
 * ================================================================ */

function fmtMoney(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  // 不做万/亿缩写, 完整数字 + 千分位
  return `${sign}${abs.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function fmtPnlPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
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

/* ================================================================
 * 汇总卡 (字体放大 + 金额/百分比红绿)
 * ================================================================ */

function LoadingSkeleton({ height = 120 }: { height?: number }) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 animate-pulse" style={{ height }}>
      <div className="h-3 w-24 bg-elevated rounded mb-3" />
      <div className="h-7 w-48 bg-elevated rounded mb-4" />
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="space-y-1.5">
            <div className="h-2.5 w-16 bg-elevated rounded" />
            <div className="h-4 w-20 bg-elevated rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-card border border-danger/30 bg-danger/5 px-4 py-3 flex items-center gap-3">
      <span className="text-xs text-danger flex-1">{message}</span>
      <button onClick={onRetry} className="px-3 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground">
        重试
      </button>
    </div>
  )
}

function SummaryCard({ s, onSetCap }: {
  s: HoldingsSummary
  onSetCap: (v: number) => void
}) {
  const [editingCap, setEditingCap] = useState(false)
  const [capInput, setCapInput] = useState('')
  const saveCap = () => {
    if (Number(capInput) > 0) onSetCap(Number(capInput))
    setEditingCap(false)
  }
  return (
    <div className="rounded-card border border-border bg-surface p-5 md:p-6">
      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="text-xs text-muted">总资产{ s.initial_cap ? <span className="ml-1">（本金 {fmtMoney(s.initial_cap, 0)}）</span> : null }</div>
          <div className={`text-3xl md:text-4xl font-bold tabular-nums mt-1.5 tracking-tight ${pnlColor(s.cum_pnl)}`}>{fmtMoney(s.total_asset)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">累计盈亏<span className="ml-1">（总资产-本金）</span></div>
          {editingCap ? (
            <div className="flex items-center gap-1.5 mt-1">
              <input autoFocus type="number" step="any" value={capInput} onChange={e => setCapInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveCap()}
                placeholder="输入本金"
                className="w-32 h-9 px-2.5 rounded-btn bg-base border border-accent/60 tabular-nums text-foreground focus:outline-none" />
              <button onClick={saveCap} className="h-9 px-3 rounded-btn bg-accent text-white text-xs">保存</button>
            </div>
          ) : (
            <button
              onClick={() => { setCapInput(s.initial_cap ? String(s.initial_cap) : ''); setEditingCap(true) }}
              className={`text-2xl md:text-3xl font-bold tabular-nums mt-1.5 tracking-tight text-left group/cap flex items-center gap-2 ${pnlColor(s.cum_pnl)}`}
              title="点击设置该账户的初始本金"
            >
              {s.cum_pnl != null ? fmtMoney(s.cum_pnl) : <span className="text-sm text-muted font-normal">设置本金</span>}
              <Pencil className="h-3.5 w-3.5 opacity-40 group-hover/cap:opacity-100" />
            </button>
          )}
          <div className="text-xs tabular-nums text-muted mt-0.5">
            本金 {fmtMoney(s.initial_cap, 0)}
            {s.total_asset != null && s.cum_pnl != null && (
              <span className={`ml-2 ${pnlColor(s.cum_pnl / s.total_asset)}`}>{fmtPnlPct(s.cum_pnl / s.total_asset)}</span>
            )}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5">
        <div>
          <div className="text-xs text-muted">当日盈亏</div>
          <div className={`text-lg font-bold tabular-nums mt-1 ${pnlColor(s.day_pnl)}`}>{fmtMoney(s.day_pnl)}</div>
          <div className={`text-sm tabular-nums ${pnlColor(s.day_pnl_pct)}`}>{fmtPct(s.day_pnl_pct)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">账本总盈亏（浮+已实现）</div>
          <div className={`text-lg font-bold tabular-nums mt-1 ${pnlColor(s.total_pnl)}`}>{fmtMoney(s.total_pnl)}</div>
          <div className={`text-sm tabular-nums ${pnlColor(s.total_pnl_pct)}`}>{fmtPct(s.total_pnl_pct)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">持仓市值 / 仓位</div>
          <div className="text-lg font-bold text-foreground tabular-nums mt-1">{fmtMoney(s.total_market_value)}</div>
          <div className="flex items-center gap-1.5 mt-1">
            <div className="w-20 h-1.5 rounded-full bg-elevated overflow-hidden">
              <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.min((s.position_pct ?? 0) * 100, 100)}%` }} />
            </div>
            <span className="text-xs text-secondary tabular-nums">{s.position_pct != null ? `${(s.position_pct * 100).toFixed(1)}%` : '—'}</span>
          </div>
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

function PnlCalendar({ daily, onPickDay, fillHeight }: { daily: { date: string; pnl: number }[]; onPickDay: (d: string) => void; fillHeight?: boolean }) {
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
  gridStart.setDate(1 - first.getDay())  // 周日开头
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
    <div className={fillHeight ? 'flex flex-col h-full min-h-0' : ''}>
      <div className="flex items-center justify-center gap-2 mb-3">
        <button onClick={() => shiftMonth(-1)} className="p-1 rounded-btn text-secondary hover:bg-elevated hover:text-foreground" title="上一月"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-base font-bold text-foreground tabular-nums">{Number(month.split('-')[1])} 月</span>
        <button onClick={() => shiftMonth(1)} className="p-1 rounded-btn text-secondary hover:bg-elevated hover:text-foreground" title="下一月"><ChevronRight className="h-4 w-4" /></button>
        <span className={`ml-2 text-sm tabular-nums font-semibold ${pnlColor(monthPnl)}`}>{fmtMoney(monthPnl)}</span>
      </div>
      <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] text-muted mb-1">
        {['日', '一', '二', '三', '四', '五', '六'].map(d => <div key={d}>{d}</div>)}
      </div>
      <div className={`grid grid-cols-7 gap-1 ${fillHeight ? 'flex-1 min-h-0 grid-rows-6' : ''}`}>
        {cells.map((c, i) => (
          <button
            key={i}
            disabled={!c.date || c.pnl == null}
            onClick={() => c.date && c.pnl != null && onPickDay(c.date)}
            title={c.date && c.pnl != null ? `${c.date} · ${fmtMoney(c.pnl)}（点击查看明细）` : ''}
            style={{ background: c.date && c.pnl != null ? bg(c.pnl) : undefined }}
            className={`${fillHeight ? 'h-full min-h-[24px]' : 'aspect-square'} rounded-md flex flex-col items-center justify-center transition-transform
              ${c.date ? 'bg-elevated/40' : 'opacity-0'}
              ${c.pnl != null ? 'text-white hover:scale-105 cursor-pointer' : 'text-muted cursor-default'}`}
          >
            {c.date && <span className={`text-[10px] tabular-nums ${c.pnl != null ? 'opacity-80' : ''}`}>{Number(c.date.slice(8))}</span>}
            {c.pnl != null && Math.abs(c.pnl) >= 1 && (
              <span className={`font-bold tabular-nums leading-tight max-w-full truncate ${c.pnl > 0 ? 'text-white' : 'text-white'} ${Math.abs(c.pnl) >= 100000 ? 'text-[10px]' : 'text-xs'}`}>
                {c.pnl > 0 ? '+' : ''}{fmtMoney(c.pnl, 0)}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2 text-[10px] text-muted shrink-0">
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

function AssetCurve({ daily, benchmark, ledgerCum }: {
  daily: { date: string; asset: number }[]
  benchmark: { dates: string[]; closes: number[]; name?: string } | undefined
  /** 账本月度累计盈亏 (权威口径): 以月末日期为点叠加 */
  ledgerCum?: { period: string; cum: number }[]
}) {
  const option = useMemo(() => {
    const b0 = benchmark?.closes?.[0]
    // x 轴 = 日度日期 ∪ 账本月末日期 (账本月份可能早于本地日度数据)
    const monthEnds = (ledgerCum ?? []).map(r => {
      const [y, m] = r.period.split('-').map(Number)
      const d = new Date(y, m, 0)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    const dates = [...new Set([...daily.map(r => r.date), ...monthEnds])].sort()
    const dailyMap = new Map(daily.map(r => [r.date, r.asset]))
    const cumMap = new Map((ledgerCum ?? []).map((r, i) => [monthEnds[i], r.cum]))
    return {
      animation: false,
      grid: { left: 60, right: 56, top: 28, bottom: 28 },
      tooltip: { trigger: 'axis', ...TOOLTIP_STYLE },
      legend: { show: !!benchmark || !!ledgerCum?.length, top: 0, right: 0, textStyle: { fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
      xAxis: { type: 'category', data: dates.map(r => r.slice(5)), axisLabel: { fontSize: 9 } },
      yAxis: [
        { type: 'value', scale: true, axisLabel: { fontSize: 9, formatter: (v: number) => fmtMoney(v, 0) }, splitLine: { lineStyle: { color: 'rgba(128,128,140,0.15)' } } },
        { type: 'value', scale: true, axisLabel: { fontSize: 9, formatter: (v: number) => `${(v * 100).toFixed(0)}%` }, splitLine: { show: false } },
      ],
      series: [
        { name: '总资产', type: 'line', data: dates.map(d => dailyMap.get(d) ?? null), showSymbol: false, connectNulls: true, lineStyle: { width: 2, color: '#3b82f6' }, areaStyle: { color: 'rgba(59,130,246,0.12)' } },
        ...(ledgerCum?.length ? [{
          name: '账本累计盈亏', type: 'line', showSymbol: true, connectNulls: true, symbolSize: 4,
          data: dates.map(d => cumMap.get(d) ?? null),
          lineStyle: { width: 1.5, color: '#a78bfa' }, itemStyle: { color: '#a78bfa' },
        }] : []),
        ...(benchmark && b0 ? [{
          name: benchmark.name || '基准', type: 'line', yAxisIndex: 1, showSymbol: false,
          data: dates.map(d => {
            const idx = benchmark.dates.indexOf(d)
            return idx >= 0 ? (benchmark.closes[idx] / b0 - 1) : null
          }),
          lineStyle: { width: 1.5, color: '#f59e0b', type: 'dashed' as const },
        }] : []),
      ],
    }
  }, [daily, benchmark, ledgerCum])
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

/** 截图汇总区展示; 累计盈亏 = 本金 - 出金 - 总资产 (本金默认读持仓资金设置, 出金默认 0) */
function ShotSummaryBlock({
  s, baseCap, onBaseCap, outFlow, onOutFlow,
}: {
  s: ShotSummary
  baseCap: string
  onBaseCap: (v: string) => void
  outFlow: string
  onOutFlow: (v: string) => void
}) {
  const fields: [string, number | null | undefined, boolean][] = [
    ['总资产', s.total_asset, false],
    ['总盈亏', s.total_pnl, true],
    ['当日盈亏', s.day_pnl, true],
    ['当日盈亏%', s.day_pnl_pct != null ? s.day_pnl_pct * 100 : null, true],
    ['总市值', s.market_value, false],
    ['可用', s.cash_available, false],
    ['可取', s.cash_withdrawable, false],
    ['仓位%', s.position_pct != null ? s.position_pct * 100 : null, false],
  ]
  const capN = Number(baseCap) || 0
  const outN = Number(outFlow) || 0
  const cumPnl = s.total_asset != null ? capN - outN - s.total_asset : null
  return (
    <div className="rounded-btn border border-border bg-elevated/30 px-3 py-2.5 space-y-2">
      <div className="text-[11px] font-medium text-secondary">截图汇总区</div>
      <div className="grid grid-cols-4 gap-x-3 gap-y-1.5">
        {fields.map(([label, v, colored]) => (
          <div key={label} className="min-w-0">
            <div className="text-[9px] text-muted truncate">{label}</div>
            <div className={`text-[11px] tabular-nums font-medium truncate ${colored ? pnlColor(v) : 'text-foreground'}`}>
              {label.includes('%') ? (v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—') : fmtMoney(v)}
            </div>
          </div>
        ))}
      </div>
      {/* 累计盈亏: 手动输入本金 - 出金 - 总资产 */}
      <div className="pt-1.5 border-t border-border/50 flex items-center gap-2 text-[11px] flex-wrap">
        <span className="text-muted">本金</span>
        <input type="number" step="any" value={baseCap} onChange={e => onBaseCap(e.target.value)} placeholder="0"
          className="w-24 h-6.5 px-2 rounded bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
        <span className="text-muted">出金</span>
        <input type="number" step="any" value={outFlow} onChange={e => onOutFlow(e.target.value)} placeholder="0"
          className="w-20 h-6.5 px-2 rounded bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
        <span className="text-muted">→ 累计盈亏 =</span>
        <span className={`tabular-nums font-semibold text-sm ${pnlColor(cumPnl)}`}>{cumPnl != null ? fmtMoney(cumPnl) : '—'}</span>
      </div>
    </div>
  )
}

function HistoryCacheBlock() {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['holdings-tzzb-history'],
    queryFn: api.holdingsTzzbHistoryStatus,
  })
  const [fetching, setFetching] = useState(false)
  const fetchNow = async () => {
    setFetching(true)
    try {
      const res = await api.holdingsTzzbHistoryFetch()
      toast(res.message, res.ok ? 'success' : 'error')
      qc.invalidateQueries({ queryKey: ['holdings-tzzb-history'] })
    } catch (e) {
      toast(e instanceof Error ? e.message : '拉取失败', 'error')
    } finally {
      setFetching(false)
    }
  }
  const st = status.data
  return (
    <div className="pt-3 border-t border-border/60 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium text-secondary">历史收益缓存</div>
        {st?.cached ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            已缓存 {st.days} 天 · {st.date}
          </span>
        ) : (
          <span className="text-[10px] text-amber-400">未缓存</span>
        )}
      </div>
      <button onClick={fetchNow} disabled={fetching}
        className="w-full h-8 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
        {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        一键获取全部历史收益
      </button>
      {st?.fetched_at && (
        <div className="text-[10px] text-muted">上次获取：{st.fetched_at.slice(0, 16).replace('T', ' ')}</div>
      )}
    </div>
  )
}

function HkRateAuto({ setHkRate }: { setHkRate: (v: string) => void }) {
  const [fetching, setFetching] = useState(false)
  const [msg, setMsg] = useState('')
  const fetchRate = async () => {
    setFetching(true)
    try {
      const r = await api.holdingsTzzbHkRate()
      if (r.rate) { setHkRate(String(r.rate)); setMsg(`已获取账本汇率 ${r.rate}`) }
      else setMsg('获取失败')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '获取失败')
    } finally {
      setFetching(false)
    }
  }
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <button onClick={fetchRate} disabled={fetching}
        className="px-2 py-1 rounded-btn bg-elevated text-[10px] text-secondary hover:text-accent inline-flex items-center gap-1"
        title="从投资账本拉取当日港币汇率">
        {fetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}自动获取
      </button>
      {msg && <span className="text-[10px] text-muted">{msg}</span>}
    </div>
  )
}

function HoldingsSettingsDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['holdings-settings'], queryFn: api.holdingsSettings })
  const [hkRate, setHkRate] = useState('')
  const [usRate, setUsRate] = useState('')
  const [deposit, setDeposit] = useState('')
  const [bench, setBench] = useState('000001.SH')
  const [keep, setKeep] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const loaded = useRef(false)

  useEffect(() => {
    if (loaded.current || !settings.data) return
    loaded.current = true
    const d = settings.data
    setHkRate(String(d.hk_rate)); setUsRate(String(d.us_rate))
    setDeposit(String(Math.round(d.hk_deposit_rate * 1000) / 10)); setBench(d.benchmark)
    setKeep(d.snapshot_keep ? String(d.snapshot_keep) : '')
  }, [settings.data])

  const save = useMutation({
    mutationFn: () => api.holdingsUpdateSettings({
      hk_rate: Number(hkRate) || undefined,
      us_rate: Number(usRate) || undefined,
      hk_deposit_rate: deposit ? Number(deposit) / 100 : undefined,
      benchmark: bench,
      snapshot_keep: keep ? Number(keep) : 0,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holdings-settings'] })
      refreshHoldingsCaches(qc)
      toast('设置已保存', 'success')
      onClose()
    },
  })

  const reset = useMutation({
    mutationFn: () => api.holdingsReset(accountId, true),
    onSuccess: (res) => {
      setConfirmReset(false)
      refreshHoldingsCaches(qc)
      toast(`已重置 ${res.account} 账户（清除 ${res.removed} 条持仓与快照）`, 'success')
      onClose()
    },
  })

  const benches: [string, string][] = [
    ['000001.SH', '上证指数'],
    ['399001.SZ', '深证成指'],
    ['HSI', '恒生指数'],
    ['SPX', '标普500'],
  ]

  const numField = (label: string, hint: string, v: string, set: (x: string) => void, step = '0.01') => (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-secondary">{label}<span className="text-muted ml-1">{hint}</span></span>
      <input type="number" step={step} value={v} onChange={e => set(e.target.value)}
        className="w-28 h-8 px-2 rounded-btn bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
    </label>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative rounded-card border border-border bg-surface shadow-2xl w-[24rem] max-w-[92vw] max-h-[86vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="text-sm font-semibold text-foreground">持仓设置</div>
          <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="space-y-2.5">
            <div className="text-[11px] font-medium text-secondary">汇率与口径</div>
            {numField('港币兑人民币', '港股市值折算', hkRate, setHkRate)}
            <HkRateAuto setHkRate={setHkRate} />
            {numField('美元兑人民币', '美股市值折算', usRate, setUsRate)}
            {numField('港股通押金率%', '成本口径说明', deposit, setDeposit, '0.1')}
            <HkRateAuto setHkRate={setHkRate} />
            <div className="text-[10px] text-muted leading-relaxed">
              港股通买入时按参考汇率+约3%押金预冻结人民币，日终按实际结算汇率清算、多退少补——券商展示的成本价含此缓冲，实际成本以清算为准。
            </div>
          </div>
          <div className="space-y-2.5 pt-3 border-t border-border/60">
            <div className="text-[11px] font-medium text-secondary">收益基准</div>
            <div className="grid grid-cols-4 gap-1.5">
              {benches.map(([k, label]) => (
                <button key={k} onClick={() => setBench(k)}
                  className={`py-1.5 rounded-btn text-[11px] ${bench === k ? 'bg-accent/15 text-accent font-medium' : 'text-secondary hover:bg-elevated'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2.5 pt-3 border-t border-border/60">
            <div className="text-[11px] font-medium text-secondary">快照保留</div>
            {numField('保留份数', '0=全部保留', keep, setKeep, '1')}
          </div>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="w-full h-9 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存设置
          </button>
          <HistoryCacheBlock />
          <div className="pt-3 border-t border-border/60 space-y-2">
            <div className="text-[11px] font-medium text-danger/80">危险操作</div>
            {!confirmReset ? (
              <button onClick={() => setConfirmReset(true)}
                className="w-full h-8 rounded-btn border border-danger/30 text-danger/80 text-xs hover:bg-danger/10">
                重置投资账本数据（清除 Cookie + 账本同步的全部账户）
              </button>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => setConfirmReset(false)} className="flex-1 h-8 rounded-btn bg-elevated text-secondary text-xs">取消</button>
                <button onClick={() => reset.mutate()} disabled={reset.isPending}
                  className="flex-1 h-8 rounded-btn bg-danger/90 text-white text-xs font-medium disabled:opacity-40 inline-flex items-center justify-center gap-1">
                  {reset.isPending && <Loader2 className="h-3 w-3 animate-spin" />}确认重置
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function refreshHoldingsCaches(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: QK.holdings })
  qc.invalidateQueries({ queryKey: QK.holdingsSummary })
  qc.invalidateQueries({ queryKey: QK.holdingsPnl() })
  qc.invalidateQueries({ queryKey: ['watchlist-enriched'] })
}

/** 投资账本连接对话框: 专用 Chrome 登录 (登录一次) + CDP 自动取 Cookie 同步 + 手动粘贴备用 */
function TzzbCookieDialog({ onClose, onConfigured }: { onClose: () => void; onConfigured: () => void }) {
  const [cookie, setCookie] = useState('')
  const [busy, setBusy] = useState<'' | 'open' | 'sync' | 'manual'>('')
  const [loginOpened, setLoginOpened] = useState(false)

  const openWindow = async () => {
    setBusy('open')
    try {
      const res = await api.holdingsTzzbOpenLogin()
      setLoginOpened(true)
      toast(res.message, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : '打开失败', 'error')
    } finally {
      setBusy('')
    }
  }

  const syncNow = async () => {
    setBusy('sync')
    try {
      const res = await api.holdingsTzzbSync()
      if (res.ok) {
        toast(res.message, 'success')
        onConfigured()
      } else {
        toast(res.message, 'error')
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '同步失败', 'error')
    } finally {
      setBusy('')
    }
  }

  const manualSave = async () => {
    if (!cookie.trim()) { toast('请先粘贴 Cookie', 'error'); return }
    setBusy('manual')
    try {
      await api.holdingsTzzbSetCookie(cookie.trim())
      toast('Cookie 已保存', 'success')
      onConfigured()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'error')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative rounded-card border border-border bg-surface shadow-2xl w-[28rem] max-w-[94vw] max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="text-sm font-semibold text-foreground">连接投资账本</div>
          <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <button
            onClick={openWindow}
            disabled={busy !== ''}
            className="w-full inline-flex flex-col items-center gap-1 px-4 py-4 rounded-btn bg-accent/10 border border-accent/30 hover:bg-accent/20 disabled:opacity-40 transition-colors"
          >
            {busy === 'open' ? <Loader2 className="h-5 w-5 animate-spin text-accent" /> : <ExternalLink className="h-5 w-5 text-accent" />}
            <span className="text-sm font-medium text-foreground">打开投资账本登录窗口</span>
            <span className="text-[10px] text-muted text-center leading-relaxed">
              用独立的 Chrome 窗口登录一次（扫码/手机号），登录态保存在专用配置里，<br />之后每小时自动同步、无需重复登录
            </span>
          </button>

          {loginOpened && (
            <button
              onClick={syncNow}
              disabled={busy !== ''}
              className="w-full h-10 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
            >
              {busy === 'sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              我已登录，立即同步
            </button>
          )}

          <div className="flex items-center gap-2 text-[10px] text-muted">
            <span className="flex-1 h-px bg-border" />备用：手动粘贴 Cookie<span className="flex-1 h-px bg-border" />
          </div>

          <details className="rounded-btn bg-elevated/40 border border-border px-3.5 py-2.5 text-[11px] text-secondary">
            <summary className="cursor-pointer text-foreground">展开：如何获取 Cookie（Chrome 快捷键 ⌥⌘I / Fn+F12）</summary>
            <div className="mt-1.5 space-y-1 leading-relaxed">
              <div>1. 用 Chrome 打开 tzzb.10jqka.com.cn 并登录</div>
              <div>2. 按 <kbd className="px-1 py-px rounded bg-base border border-border font-mono text-[10px]">⌥⌘I</kbd>（或 <kbd className="px-1 py-px rounded bg-base border border-border font-mono text-[10px]">Fn+F12</kbd>）打开开发者工具</div>
              <div>3. 切到 <span className="text-foreground">Network（网络）</span> → 刷新页面</div>
              <div>4. 点任意一条发往 tzzb.10jqka.com.cn 的请求</div>
              <div>5. 「标头」→「请求标头」→ <span className="text-foreground">Cookie:</span> 行 → 复制整段值粘贴到下方</div>
            </div>
          </details>
          <textarea
            value={cookie}
            onChange={e => setCookie(e.target.value)}
            placeholder="粘贴 Cookie（备用方式）"
            rows={2}
            className="w-full px-2.5 py-2 rounded-btn bg-base border border-border text-[11px] font-mono text-foreground focus:outline-none focus:border-accent/50 resize-none"
          />
          <button onClick={manualSave} disabled={busy !== '' || !cookie.trim()}
            className="w-full h-8 rounded-btn bg-elevated text-secondary text-xs hover:text-foreground disabled:opacity-40">
            保存 Cookie
          </button>
        </div>
      </div>
    </div>
  )
}function HoldingsImportDialog({ onClose, initialImages }: { onClose: () => void; initialImages?: PickedImage[] }) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [queue, setQueue] = useState<PickedImage[]>([])
  const [shotSummary, setShotSummary] = useState<ShotSummary | null>(null)
  const [baseCap, setBaseCap] = useState('')
  const [outFlow, setOutFlow] = useState('')
  const [syncCash, setSyncCash] = useState(true)

  // 本金默认读「我的持仓」资金设置, 免去每次手填
  useEffect(() => {
    api.holdingsSummary()
      .then(r => { if (r.initial_cap > 0) setBaseCap(String(r.initial_cap)) })
      .catch(() => {})
  }, [])
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

  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current || !initialImages?.length) return
    autoStarted.current = true
    setQueue(initialImages)
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    void recognizeAll(initialImages)
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

  const recognizeAll = async (imgs?: PickedImage[]) => {
    const list = imgs && imgs.length ? imgs : queue
    if (list.length === 0) { toast('请先选择截图', 'error'); return }
    setBusy(true)
    const out: ImageResult[] = []
    let latestDate = ''
    let totalRows = 0
    for (let i = 0; i < list.length; i++) {
      setProgress(`识别中 ${i + 1}/${list.length}…`)
      const url = URL.createObjectURL(list[i].file)
      const rows: Row[] = []
      try {
        const res = await api.watchlistImportImage(list[i].file, undefined, true)
        setProvider(res.provider)
        if (res.summary && Object.values(res.summary).some(v => v != null)) setShotSummary(res.summary)
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
      out.push({ img: list[i], url, rows })
      if (list[i].date > latestDate) latestDate = list[i].date
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

  const goNext = () => {
    if (!cur) return
    // 局部变量传递, 避免 setState 异步导致汇总读到空 acceptedRows
    const kept = curRows.filter(r => curChecked.has(r.symbol) && r.symbol && Number(r.qty) >= 0)
    const mergedAccepted = [...acceptedRows, ...kept]
    setAcceptedRows(mergedAccepted)
    const next = confirmIdx + 1
    if (next < results.length) {
      setConfirmIdx(next)
      setCurRows(results[next].rows)
      setCurChecked(new Set(results[next].rows.map(r => r.symbol)))
    } else {
      enterSummary(mergedAccepted)
    }
  }

  const enterSummary = (rows: Row[]) => {
    // 汇总去重: 同 symbol 保留数量大的
    const bySymbol = new Map<string, Row>()
    for (const r of rows) {
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
    onSuccess: async (res) => {
      qc.invalidateQueries({ queryKey: QK.holdings })
      qc.invalidateQueries({ queryKey: QK.holdingsSummary })
      qc.invalidateQueries({ queryKey: QK.holdingsPnl() })
      qc.invalidateQueries({ queryKey: QK.watchlist })
      qc.invalidateQueries({ queryKey: ['watchlist-enriched'] })
      // 截图汇总联动: 今日 → 可用同步到现金 + 本金核准值可写回; 历史 → 当日现金已随快照
      try {
        if (!res.snapshot) {
          const patch: { cash?: number; initial_cap?: number } = {}
          if (syncCash && shotSummary?.cash_available != null) patch.cash = shotSummary.cash_available
          const capN = Number(baseCap)
          if (capN > 0 && capN !== (await qc.fetchQuery({ queryKey: ['holdings-summary-base'], queryFn: () => api.holdingsSummary() })).initial_cap) patch.initial_cap = capN
          if (Object.keys(patch).length) await api.holdingsPortfolio(patch)
          qc.invalidateQueries({ queryKey: QK.holdingsSummary })
        }
      } catch { /* 资金同步失败不影响导入结果 */ }
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
            className="w-20 px-1.5 h-7 rounded bg-base border border-border text-right tabular-nums focus:outline-none focus:border-accent/50" />
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
                <button onClick={() => recognizeAll()} disabled={busy}
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
              {shotSummary && <ShotSummaryBlock
                s={shotSummary}
                baseCap={baseCap}
                onBaseCap={setBaseCap}
                outFlow={outFlow}
                onOutFlow={setOutFlow}
              />}
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
            {shotSummary && <ShotSummaryBlock s={shotSummary} baseCap={baseCap} onBaseCap={setBaseCap} outFlow={outFlow} onOutFlow={setOutFlow} />}
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
              {isToday && shotSummary?.cash_available != null && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={syncCash} onChange={e => setSyncCash(e.target.checked)} className="rounded border-border" />
                  <span className="text-secondary">
                    同步可用资金到现金（截图可用 {fmtMoney(shotSummary.cash_available)}）
                  </span>
                </label>
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

function BgTasksPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const tasks = useQuery({ queryKey: ['holdings-bg-tasks'], queryFn: api.holdingsBgTasks, refetchInterval: 30_000 })
  const trades = useQuery({ queryKey: ['holdings-tzzb-trades'], queryFn: api.holdingsTzzbTrades })
  const [busy, setBusy] = useState('')
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try { await fn(); toast(`${label}完成`, 'success'); qc.invalidateQueries() }
    catch { toast(`${label}失败`, 'error') }
    finally { setBusy('') }
  }
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute top-14 right-4 w-80 rounded-card border border-border bg-surface shadow-xl p-4 space-y-2"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-foreground">后台任务</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        {(tasks.data?.tasks ?? []).map(t => (
          <div key={t.key} className="flex items-center gap-2 text-xs" title={t.ok === false ? '上次执行失败' : undefined}>
            <span className={`w-1.5 h-1.5 rounded-full ${t.running ? 'bg-emerald-400 animate-pulse' : (t.ok === false ? 'bg-amber-400' : 'bg-muted')}`} />
            <span className="text-secondary">{t.name}</span>
            <div className="flex-1" />
            <span className="text-muted tabular-nums">{t.last_run ? t.last_run.slice(5, 16).replace('T', ' ') : (t.running ? '运行中' : '—')}</span>
          </div>
        ))}
        <div className="border-t border-border/60 pt-2 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-secondary">真实成交缓存</span>
            <span className="text-muted tabular-nums">
              {trades.data ? `${trades.data.n_trades} 笔 · ${trades.data.fetched_at?.slice(5, 16).replace('T', ' ') ?? ''}` : '未拉取'}
            </span>
          </div>
          {trades.data && (
            <div className="text-[11px] text-muted">{trades.data.accounts.map(a => `${a.name}: ${a.trades}`).join(' · ')}</div>
          )}
          <div className="flex gap-2 pt-0.5">
            <button disabled={!!busy} onClick={() => run('成交拉取', () => api.holdingsTzzbTradesRefresh())}
              className="flex-1 px-2 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground disabled:opacity-40">
              {busy === '成交拉取' ? '拉取中…' : '立即拉取真实成交'}
            </button>
            <button disabled={!!busy} onClick={() => run('历史拉取', () => api.holdingsTzzbHistoryFetch())}
              className="flex-1 px-2 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground disabled:opacity-40">
              {busy === '历史拉取' ? '拉取中…' : '立即拉取历史收益'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function AiReportPanel({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'running' | 'done' | 'error'>('running')
  const [saved, setSaved] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const reportsQ = useQuery({
    queryKey: ['holdings-reports'],
    queryFn: api.holdingsReportsList,
    enabled: showHistory,
  })
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
        <button onClick={() => setShowHistory(v => !v)} className="text-[11px] text-secondary hover:text-accent">历史报告</button>
        <button onClick={onClose} className="p-1 rounded-btn text-secondary hover:bg-elevated"><X className="h-4 w-4" /></button>
      </div>
      {showHistory && (
        <div className="px-4 py-2 border-b border-border max-h-40 overflow-y-auto space-y-1">
          {(reportsQ.data?.reports ?? []).map(r => (
            <div key={r.id} className="flex items-center gap-2 text-xs group">
              <button className="text-secondary hover:text-accent truncate" title={r.summary || r.content.slice(0, 80)}
                onClick={() => { setText(r.content); setStatus('done') }}>
                {r.date} · {(r.saved_at || '').slice(11, 16)}
              </button>
              <div className="flex-1" />
              <button onClick={() => api.holdingsReportsDelete(r.id).then(() => reportsQ.refetch())}
                className="opacity-0 group-hover:opacity-100 text-muted hover:text-danger text-[10px]">删除</button>
            </div>
          ))}
          {(reportsQ.data?.reports ?? []).length === 0 && (
            <div className="text-[11px] text-muted py-1">{reportsQ.isLoading ? '加载中…' : '暂无历史报告 (生成后点「保存此报告」留存)'}</div>
          )}
        </div>
      )}
      <div ref={boxRef} className="px-4 py-3 max-h-96 overflow-y-auto">
        {text ? renderMd(text) : status === 'running' ? (
          <div className="text-xs text-muted py-4 text-center">正在读取持仓与近期行情，生成体检报告…</div>
        ) : null}
      </div>
      {status === 'done' && text && (
        <div className="px-4 py-2 border-t border-border flex items-center gap-2">
          <button onClick={() => {
            const rep = api.holdingsReportsSave({ date: new Date().toISOString().slice(0,10), content: text, summary: text.slice(0, 80) })
            Promise.resolve(rep).then(() => toast('报告已保存', 'success')).catch(() => {})
            setSaved(true)
          }} disabled={saved}
            className="text-[11px] text-accent hover:underline inline-flex items-center gap-1">
            <Check className="h-3 w-3" />{saved ? '已保存' : '保存此报告'}
          </button>
          <span className="text-[10px] text-muted">保存在本地，可在历史报告中查看</span>
        </div>
      )}
    </div>
  )
}

/* ================================================================
 * 主页面
 * ================================================================ */

type SortKey = 'name' | 'price' | 'change_pct' | 'qty' | 'avg_cost' | 'market_value' | 'float_pnl' | 'day_pnl'
  | 'pre_profit' | 'hold_days' | 'm1_rate' | 'm3_rate' | 'm6_rate' | 'm12_rate' | 'position_rate'

export function Holdings() {
  const qc = useQueryClient()
  const [year, setYear] = useState(new Date().getFullYear())
  const [editing, setEditing] = useState<HoldingRow | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showClosed, setShowClosed] = useState(true)
  const [closedSort, setClosedSort] = useState<{ col: number; dir: 'asc' | 'desc' }>({ col: 2, dir: 'desc' })
  const [dayDetail, setDayDetail] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  const [aiKey, setAiKey] = useState(0)
  const [previewSymbol, setPreviewSymbol] = useState<string | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [previewMarkers, setPreviewMarkers] = useState<any[] | undefined>(undefined)
  const [previewMarkerSrc, setPreviewMarkerSrc] = useState<'tzzb' | 'calc' | undefined>(undefined)
  const openPreview = (sym: string, name: string) => {
    setPreviewSymbol(sym)
    setPreviewName(name)
    setPreviewMarkers(undefined)
    setPreviewMarkerSrc(undefined)
    // 持仓股: 拉 B/S 买卖点 (账本真实成交优先, 快照推算兜底)
    api.holdingsTrades(sym, activeAcc || undefined).then(d => {
      const mk = (d.events ?? []).map(ev => ({
        date: ev.date,
        kind: ev.type === 'B' ? 'buy' : 'sell',
        // B/S 常显 + 悬浮(axis tooltip)显示成交均价 (账本来源时含当日已实现)
        label: ev.type === 'B' ? `B ${ev.price}` : `S ${ev.price}${ev.profit ? ` (${ev.profit > 0 ? '+' : ''}${Math.round(ev.profit)})` : ''}`,
        price: ev.price,
      }))
      setPreviewMarkers(mk.length ? mk : undefined)
      setPreviewMarkerSrc(d.source)
    }).catch(() => {})
  }
  const [sortKey, setSortKey] = useState<SortKey>('market_value')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('tf-holdings-hidden-cols') || '[]')) }
    catch { return new Set() }
  })
  const [showColMenu, setShowColMenu] = useState(false)
  const toggleCol = (k: string) => {
    const next = new Set(hiddenCols)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setHiddenCols(next)
    localStorage.setItem('tf-holdings-hidden-cols', JSON.stringify([...next]))
  }

  // 账户
  const accountsQ = useQuery({
    queryKey: ['holdings-accounts'],
    queryFn: api.holdingsAccounts,
    placeholderData: (prev) => prev,
    retry: 1,
  })
  const [activeAcc, setActiveAcc] = useState<string>('')
  const accounts = accountsQ.data?.accounts ?? []
  useEffect(() => {
    const d = accountsQ.data
    if (!d) return
    const ids = new Set(d.accounts.map(a => a.id))
    const stored = localStorage.getItem('tf-holdings-account')
    const target = (stored && ids.has(stored)) ? stored
      : (activeAcc && ids.has(activeAcc)) ? activeAcc : d.active
    if (target !== activeAcc) setActiveAcc(target)
  }, [accountsQ.data, activeAcc])

  const holdings = useQuery({
    queryKey: [...QK.holdings, activeAcc], queryFn: () => api.holdingsList(false, activeAcc || undefined),
    enabled: !!activeAcc,
    placeholderData: (prev) => prev,
    retry: 1,
    refetchInterval: 60_000,
  })
  const closedQ = useQuery({
    queryKey: [...QK.holdings, 'closed', activeAcc],
    queryFn: () => api.holdingsList(true, activeAcc || undefined),
    enabled: !!activeAcc,
  })
  const closedRows = (closedQ.data?.rows ?? []).filter(r => r.status === 'closed')
  const closedRealized = closedRows.reduce((sum, r) => sum + (r.realized_pnl ?? 0), 0)
  const summary = useQuery({
    queryKey: [...QK.holdingsSummary, activeAcc], queryFn: () => api.holdingsSummary(activeAcc || undefined),
    enabled: !!activeAcc,
    placeholderData: (prev) => prev,
    retry: 1,
    refetchInterval: 60_000,
  })
  const pnl = useQuery({
    queryKey: [...QK.holdingsPnl(`${year}-01-01`), activeAcc],
    queryFn: () => api.holdingsPnl(`${year}-01-01`, undefined, activeAcc || undefined),
    enabled: !!activeAcc,
    placeholderData: (prev) => prev,
  })
  const benchmark = useQuery({
    queryKey: ['holdings-benchmark', year, activeAcc],
    queryFn: async () => {
      const st = await api.holdingsSettings()
      return api.holdingsBenchmark(`${year}-01-01`, st.benchmark)
    },
    enabled: !!activeAcc,
  })
  // 账本权威月度收益 (投资账本缓存)
  const historyData = useQuery({
    queryKey: ['holdings-tzzb-history-data'],
    queryFn: api.holdingsTzzbHistoryData,
  })
  // 清仓核对 (账本成交派生 vs 本地已清仓)
  const clearedCheck = useQuery({
    queryKey: ['holdings-tzzb-cleared-check', activeAcc],
    queryFn: () => api.holdingsTzzbClearedCheck(activeAcc || undefined),
  })
  const [showTasks, setShowTasks] = useState(false)

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
        case 'pre_profit': return r.pre_profit ?? -Infinity
        case 'hold_days': return r.hold_days ?? -Infinity
        case 'm1_rate': return r.m1_rate ?? -Infinity
        case 'm3_rate': return r.m3_rate ?? -Infinity
        case 'm6_rate': return r.m6_rate ?? -Infinity
        case 'm12_rate': return r.m12_rate ?? -Infinity
        case 'position_rate': return r.position_rate ?? -Infinity
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

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: QK.holdings })
    qc.invalidateQueries({ queryKey: QK.holdingsSummary })
    qc.invalidateQueries({ queryKey: QK.holdingsPnl() })
  }

  const remove = useMutation({
    mutationFn: (symbol: string) => api.holdingsRemove(symbol, activeAcc || undefined),
    onSuccess: () => { refreshAll(); qc.invalidateQueries({ queryKey: ['watchlist-enriched'] }); toast('已删除持仓记录', 'success') },
  })

  const monthNow = new Date().getMonth() + 1
  const activeAccName = accounts.find(a => a.id === activeAcc)?.name ?? ''
  const useLedgerMonthly = !!(historyData.data?.cached && historyData.data.monthly?.length)
  const yearPnl = pnl.data?.yearly?.[0]?.pnl
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
    { key: 'pre_profit', label: '当日参考' },
    { key: 'hold_days', label: '持有天数' },
    { key: 'm1_rate', label: '近1月' },
    { key: 'm3_rate', label: '近3月' },
    { key: 'm6_rate', label: '近6月' },
    { key: 'm12_rate', label: '近12月' },
    { key: 'position_rate', label: '占比' },
  ]
  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc') }
  }

  // 列顺序 + 预设 (多套显隐+顺序方案, localStorage 持久化)
  const DEFAULT_ORDER = sortHeaders.map(h => h.key)
  const [colOrder, setColOrder] = useState<SortKey[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('tf-holdings-col-order') || 'null') as SortKey[] | null
      if (Array.isArray(saved) && saved.length === DEFAULT_ORDER.length && DEFAULT_ORDER.every(k => saved.includes(k))) return saved
    } catch { /* ignore */ }
    return DEFAULT_ORDER
  })
  const saveOrder = (order: SortKey[]) => {
    setColOrder(order)
    localStorage.setItem('tf-holdings-col-order', JSON.stringify(order))
  }
  const moveCol = (k: SortKey, dir: -1 | 1) => {
    const i = colOrder.indexOf(k)
    const j = i + dir
    if (i < 0 || j < 0 || j >= colOrder.length) return
    const next = [...colOrder]
    ;[next[i], next[j]] = [next[j], next[i]]
    saveOrder(next)
  }
  const visibleCols = useMemo(() => colOrder.filter(k => !hiddenCols.has(k)), [colOrder, hiddenCols])
  const [presets, setPresets] = useState<Record<string, { hidden: string[]; order: SortKey[] }>>(() => {
    try { return JSON.parse(localStorage.getItem('tf-holdings-col-presets') || '{}') } catch { return {} }
  })
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const persistPresets = (next: Record<string, { hidden: string[]; order: SortKey[] }>) => {
    setPresets(next)
    localStorage.setItem('tf-holdings-col-presets', JSON.stringify(next))
  }
  const savePreset = () => {
    const name = window.prompt('预设名称 (如「全面版」「精简版」)')
    if (!name?.trim()) return
    persistPresets({ ...presets, [name.trim()]: { hidden: [...hiddenCols], order: colOrder } })
    setActivePreset(name.trim())
    toast(`预设「${name.trim()}」已保存`, 'success')
  }
  const applyPreset = (name: string) => {
    const ps = presets[name]
    if (!ps) return
    setHiddenCols(new Set(ps.hidden))
    localStorage.setItem('tf-holdings-hidden-cols', JSON.stringify(ps.hidden))
    saveOrder(ps.order)
    setActivePreset(name)
  }

  // 列内容渲染 (配合 colOrder 自定义顺序)
  const renderCell = (key: SortKey, r: HoldingRow) => {
    switch (key) {
      case 'name': return (
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            {(REGION_BADGE[r.region ?? 'CN']) && <span className={`px-1 py-px rounded text-[9px] font-bold border ${REGION_BADGE[r.region ?? 'CN'].cls}`}>{REGION_BADGE[r.region ?? 'CN'].label}</span>}
            <span className="text-foreground font-medium">{r.name || '—'}</span>
            <span className="font-mono text-muted text-xs">{r.symbol}</span>
          </div>
        </td>
      )
      case 'price': return <td className={`px-3 py-2.5 tabular-nums font-medium ${pnlColor(r.change_pct)}`}>{r.price?.toFixed(2) ?? '—'}</td>
      case 'change_pct': return <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.change_pct)}`}>{fmtPct(r.change_pct)}</td>
      case 'qty': return <td className="px-3 py-2.5 tabular-nums text-secondary">{r.qty}{r.available != null && r.available !== r.qty ? <span className="text-muted"> / {r.available}</span> : ''}</td>
      case 'avg_cost': return <td className="px-3 py-2.5 tabular-nums text-secondary">{r.avg_cost?.toFixed(3) ?? '—'}</td>
      case 'market_value': return <td className="px-3 py-2.5 tabular-nums text-foreground">{r.qty === 0 ? '—' : fmtMoney(r.market_value)}</td>
      case 'float_pnl': return (
        <td className={`px-3 py-2.5 tabular-nums font-semibold ${pnlColor(r.float_pnl)}`}>
          {r.qty === 0 ? '—' : fmtMoney(r.float_pnl)}{r.qty !== 0 && <span className="text-[11px] font-normal ml-1">{fmtPct(r.float_pnl_pct)}</span>}
        </td>
      )
      case 'day_pnl': return <td className={`px-3 py-2.5 tabular-nums font-semibold ${pnlColor(r.day_pnl)}`}>{r.qty === 0 ? '—' : fmtMoney(r.day_pnl)}</td>
      case 'pre_profit': return <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.pre_profit)}`}>{fmtMoney(r.pre_profit)}</td>
      case 'hold_days': return <td className="px-3 py-2.5 tabular-nums text-secondary">{r.hold_days != null ? Math.round(r.hold_days) : '—'}</td>
      case 'm1_rate': return <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.m1_rate)}`}>{fmtPct(r.m1_rate)}</td>
      case 'm3_rate': return <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.m3_rate)}`}>{fmtPct(r.m3_rate)}</td>
      case 'm6_rate': return <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.m6_rate)}`}>{fmtPct(r.m6_rate)}</td>
      case 'm12_rate': return <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.m12_rate)}`}>{fmtPct(r.m12_rate)}</td>
      case 'position_rate': return <td className="px-3 py-2.5 tabular-nums text-secondary">{r.position_rate != null ? `${(r.position_rate * 100).toFixed(1)}%` : '—'}</td>
    }
  }

  // 投资账本同步 (导入 + 刷新共用; 成功/失败都 toast)
  const [tzzbSyncing, setTzzbSyncing] = useState(false)
  const [showCookieDialog, setShowCookieDialog] = useState(false)
  const tzzbStatus = useQuery({
    queryKey: ['holdings-tzzb-status'],
    queryFn: api.holdingsTzzbStatus,
    refetchInterval: 60_000,
  })

  const doSync = async (isRefresh: boolean) => {
    setTzzbSyncing(true)
    try {
      const res = await api.holdingsTzzbSync(activeAcc || undefined)
      refreshAll()
      qc.invalidateQueries({ queryKey: ['holdings-accounts'] })
      qc.invalidateQueries({ queryKey: ['holdings-tzzb-status'] })
      if (res.ok) {
        toast(`${isRefresh ? '刷新' : '导入'}成功：${res.message}`, 'success')
        // 手动刷新时异步更新真实成交缓存 (B/S 点 + 清仓核对数据源)
        api.holdingsTzzbTradesRefresh()
          .then(() => qc.invalidateQueries({ queryKey: ['holdings-tzzb-cleared-check'] }))
          .catch(() => {})
      } else {
        toast(`${isRefresh ? '刷新' : '导入'}失败：${res.message}`, 'error')
      }
      return res.ok
    } catch (e) {
      toast(e instanceof Error ? e.message : '同步失败', 'error')
      return false
    } finally {
      setTzzbSyncing(false)
    }
  }

  const runTzzbSync = async (isRefresh = false) => {
    const st = await api.holdingsTzzbStatus().catch(() => null)
    if (!st?.cookie_set) {
      setShowCookieDialog(true)  // 未配置/已清除 → 先弹 Cookie 配置对话框
      return
    }
    void doSync(isRefresh)
  }

  // 整页拖拽截图 → 自动识别导入
  const [dragOver, setDragOver] = useState(false)
  const [dropImages, setDropImages] = useState<PickedImage[] | undefined>(undefined)
  const [dropKey, setDropKey] = useState(0)

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? []).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    setDropImages(files.map(f => ({
      file: f,
      date: f.lastModified ? new Date(f.lastModified).toISOString().slice(0, 10) : todayIso(),
      key: `drop:${f.name}:${f.lastModified}:${Date.now()}`,
    })))
    setDropKey(k => k + 1)
    setShowImport(true)
  }

  return (
    <div
      className="h-full flex flex-col relative"
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center">
          <div className="absolute inset-2 rounded-card border-2 border-dashed border-accent/70 bg-accent/5" />
          <div className="relative text-sm font-medium text-accent bg-surface/90 px-4 py-2 rounded-card border border-accent/30 shadow-lg">
            松开鼠标，自动识别持仓截图
          </div>
        </div>
      )}
      {/* 页头 */}
      <div className="px-4 md:px-6 py-3 border-b border-border flex items-center gap-3 flex-wrap shrink-0">
        <Briefcase className="h-5 w-5 text-accent" />
        <h1 className="text-base font-bold text-foreground">我的持仓</h1>
        <span className="text-xs text-muted">{rows.length} 只</span>
        <div className="flex-1" />
        {/* 账户页签: 名称 + 当日盈亏 */}
        <div className="flex items-center gap-1 p-0.5 rounded-btn bg-elevated">
          {[...accounts].sort((x, y) => (Number(x.id === 'default')) - Number(y.id === 'default')).map(a => {
            const active = a.id === activeAcc
            return (
              <button key={a.id}
                onClick={() => {
                  setActiveAcc(a.id)
                  localStorage.setItem('tf-holdings-account', a.id)
                  api.holdingsSetActiveAccount(a.id).catch(() => {})
                  refreshAll()
                }}
                className={`px-2.5 py-1 rounded-[6px] text-xs transition-colors ${active ? 'bg-surface text-foreground font-medium shadow-sm' : 'text-secondary hover:text-foreground'}`}
                title={`${a.name} · ${a.positions ?? 0} 只持仓${(a.tzzb_count ?? 0) > 0 ? ` · 账本同步 ${a.tzzb_count} 只` : ''}`}>
                {a.name}
                {(a.tzzb_count ?? 0) > 0 && <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400 ml-0.5 align-middle" />}
                {(a.day_pnl != null) ? (
                  <span className={`ml-1 tabular-nums ${pnlColor(a.day_pnl)}`}>
                    {fmtMoney(a.day_pnl)}{a.day_pnl_pct != null && <span className="text-[9px]"> {fmtPct(a.day_pnl_pct)}</span>}
                  </span>
                ) : ((a.positions ?? 0) > 0 && <span className="ml-1 text-muted" title="行情加载中…">…</span>)}
              </button>
            )
          })}
          <button
            onClick={() => {
              const name = window.prompt('新账户名称（如「港美股」「打新」）')
              if (!name?.trim()) return
              api.holdingsCreateAccount(name.trim()).then(acc => {
                qc.invalidateQueries({ queryKey: ['holdings-accounts'] })
                setActiveAcc(acc.id)
                toast(`账户「${acc.name}」已创建`, 'success')
              }).catch(() => toast('创建失败', 'error'))
            }}
            className="px-1.5 py-1 rounded-[6px] text-xs text-muted hover:text-accent"
            title="新建账户"
          >+</button>
        </div>
        <button onClick={() => setShowSettings(true)} className="p-1.5 rounded-btn text-secondary hover:text-foreground hover:bg-elevated" title="持仓设置">
          <SettingsIcon className="h-4 w-4" />
        </button>
        {tzzbStatus.data && (tzzbStatus.data.last_ok ? (
          <button onClick={() => setShowTasks(true)}
            className="inline-flex items-center gap-1 text-[11px] text-muted tabular-nums hover:text-foreground"
            title={`投资账本数据更新于 ${tzzbStatus.data.last_sync} · 点击查看后台任务`}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            数据 {tzzbStatus.data.last_sync?.slice(11, 16)}
          </button>
        ) : (
          <button onClick={() => void runTzzbSync()} disabled={tzzbSyncing}
            className="inline-flex items-center gap-1 text-[11px] text-amber-400 hover:underline disabled:opacity-40"
            title={tzzbStatus.data.last_result || '投资账本数据尚未获取成功'}>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            重新导入投资账本数据
          </button>
        ))}
        <button
          onClick={() => void runTzzbSync()}
          disabled={tzzbSyncing}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-btn border border-rose-500/40 bg-rose-500/10 text-rose-400 text-xs font-medium hover:bg-rose-500/20 disabled:opacity-40"
          title="从同花顺投资账本拉取持仓 (需在设置里配置 Cookie)"
        >
          <BookMarked className="h-3.5 w-3.5" />投资账本导入
        </button>
        <button onClick={() => void runTzzbSync(true)} disabled={tzzbSyncing}
          className="p-1.5 rounded-btn text-secondary hover:text-foreground hover:bg-elevated disabled:opacity-40"
          title="刷新投资账本数据">
          <RefreshCw className={`h-4 w-4 ${tzzbSyncing ? 'animate-spin' : ''}`} />
        </button>
        <button onClick={() => setShowImport(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground border border-border"><Camera className="h-3.5 w-3.5" />截图导入</button>
        <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-btn bg-accent text-white text-xs font-medium hover:bg-accent/90"><Plus className="h-3.5 w-3.5" />手动添加</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-4">
        {summary.error && <ErrorBanner message={`汇总加载失败：${(summary.error as Error).message}`} onRetry={refreshAll} />}
        {holdings.error && <ErrorBanner message={`持仓加载失败：${(holdings.error as Error).message}`} onRetry={refreshAll} />}
        {!s && !summary.isLoading && !holdings.isLoading && (
          <LoadingSkeleton height={140} />
        )}
        {s && <SummaryCard s={s} onSetCap={(v) => {
          api.holdingsPortfolio({ initial_cap: v }).then(() => {
            qc.invalidateQueries({ queryKey: QK.holdingsSummary })
            qc.invalidateQueries({ queryKey: QK.holdingsPnl() })
            toast('本金已保存', 'success')
          }).catch(() => toast('保存失败', 'error'))
        }} />}

        {showAi && <AiReportPanel key={aiKey} onClose={() => setShowAi(false)} />}

        {(() => {
          const c = rows.find(r => (r.position_rate ?? 0) > 0.4)
          return c ? (
            <div className="rounded-btn border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-400">
              ⚠ 持仓集中度提醒：{c.name || c.symbol} 占账户 {((c.position_rate ?? 0) * 100).toFixed(0)}%，建议关注分散风险
            </div>
          ) : null
        })()}
        {/* 持仓明细 (可排序 + 点击查看) */}
        <div className="rounded-card border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2 relative">
            <TrendingUp className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold text-foreground">持仓明细</span>
            <span className="text-[10px] text-muted">点列名排序 · 点行查看个股</span>
            <button
              onClick={() => { setShowAi(true); setAiKey(k => k + 1) }}
              className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded-btn border border-violet-500/40 bg-violet-500/10 text-violet-400 text-[11px] font-medium hover:bg-violet-500/20"
            >
              <Sparkles className="h-3 w-3" />AI 分析
            </button>
            <div className="flex-1" />
            <div className="relative">
              <button onClick={() => setShowColMenu(v => !v)} className="text-[11px] text-secondary hover:text-foreground">
                列显示
              </button>
              {showColMenu && (
                <div className="absolute right-0 top-full mt-1 z-30 w-48 rounded-btn border border-border bg-surface shadow-xl p-2 space-y-0.5 max-h-[70vh] overflow-y-auto">
                  <div className="flex items-center justify-between px-1.5 pb-1">
                    <span className="text-[10px] text-muted">↑↓ 调整列顺序</span>
                    <button onClick={() => { setHiddenCols(new Set()); localStorage.setItem('tf-holdings-hidden-cols', '[]') }}
                      className="text-[10px] text-accent hover:underline">全部显示</button>
                  </div>
                  {colOrder.map(k => {
                    const h = sortHeaders.find(x => x.key === k)!
                    return (
                      <div key={k} className="flex items-center gap-1 text-xs px-1.5 py-1 rounded hover:bg-elevated">
                        <input type="checkbox"
                          checked={!hiddenCols.has(k)}
                          onChange={() => toggleCol(k)}
                          className="rounded border-border" />
                        <span className={`flex-1 cursor-pointer ${hiddenCols.has(k) ? 'text-muted' : ''}`}
                          onClick={() => toggleCol(k)}>{h.label}</span>
                        <button onClick={() => moveCol(k, -1)} className="px-0.5 text-muted hover:text-foreground" title="左移">↑</button>
                        <button onClick={() => moveCol(k, 1)} className="px-0.5 text-muted hover:text-foreground" title="右移">↓</button>
                      </div>
                    )
                  })}
                  <div className="border-t border-border/60 mt-1 pt-1.5 px-1.5 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-muted">列预设</span>
                      <button onClick={savePreset} className="text-[10px] text-accent hover:underline">保存当前</button>
                    </div>
                    {Object.keys(presets).length === 0 && <div className="text-[10px] text-muted">暂无预设</div>}
                    {Object.entries(presets).map(([name, ps]) => (
                      <div key={name} className="flex items-center gap-1 text-xs group">
                        <button onClick={() => applyPreset(name)}
                          className={`flex-1 text-left truncate ${activePreset === name ? 'text-accent' : 'text-secondary hover:text-foreground'}`}>
                          {name}{activePreset === name ? ' ✓' : ''} <span className="text-muted">({ps.order.length - ps.hidden.length} 列)</span>
                        </button>
                        <button onClick={() => { const next = { ...presets }; delete next[name]; persistPresets(next); if (activePreset === name) setActivePreset(null) }}
                          className="opacity-0 group-hover:opacity-100 text-muted hover:text-danger text-[10px]">删</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={() => window.open(`/api/holdings/export/holdings.csv${activeAcc ? `?account=${encodeURIComponent(activeAcc)}` : ''}`, '_blank')}
              className="text-[11px] text-accent hover:underline"
            >导出 CSV</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" style={{ minWidth: Math.max(visibleCols.length, 6) * 92 }}>
              <thead>
                <tr className="text-muted border-b border-border/60 bg-elevated/30">
                  {visibleCols.map(k => {
                    const h = sortHeaders.find(x => x.key === k)!
                    return (
                      <th key={k} onClick={() => toggleSort(k)}
                        className="px-3 py-2.5 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:text-foreground">
                        {h.label}
                        {sortKey === k && <span className="ml-0.5 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                      </th>
                    )
                  })}
                  <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody>
                {holdings.isLoading && rows.length === 0 && (
                  <tr><td colSpan={15} className="px-3 py-10 text-center text-muted text-xs">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />持仓数据加载中…
                  </td></tr>
                )}
                {rows.map(r => {
                  const concentrated = (r.position_rate ?? 0) > 0.4
                  return (
                    <tr key={r.symbol} className={`border-b border-border/40 hover:bg-elevated/30 transition-colors cursor-pointer ${concentrated ? 'bg-amber-400/[0.07]' : ''}`}
                      onClick={() => openPreview(r.symbol, r.name || '')}>
                      {visibleCols.map(k => <Fragment key={k}>{renderCell(k, r)}</Fragment>)}
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
                  <tr><td colSpan={15} className="px-3 py-12 text-center">
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

        {/* 清仓明细 */}
        {closedRows.length > 0 && (
          <div className="rounded-card border border-border bg-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">已清仓明细</span>
              <span className="text-xs text-muted">{closedRows.length} 只</span>
              <span className={`text-xs tabular-nums font-medium ${pnlColor(closedRealized)}`}>已实现合计 {fmtMoney(closedRealized)}</span>
              {clearedCheck.data?.ok && (() => {
                const cc = clearedCheck.data
                const diffs = cc.local_only.length + cc.ledger_only.length
                const tip = diffs === 0
                  ? `账本成交核对一致 (${cc.matched.length} 只)`
                  : `本地独有: ${cc.local_only.join(', ') || '无'}\n账本独有: ${cc.ledger_only.map(x => `${x.symbol}${x.last_sell ? `(${x.last_sell})` : ''}`).join(', ') || '无'}`
                return diffs === 0 ? (
                  <span className="text-[10px] text-emerald-400" title={tip}>✓ 账本核对一致</span>
                ) : (
                  <span className="text-[10px] text-amber-400 whitespace-pre" title={tip}>⚠ 核对差异 {diffs} 条</span>
                )
              })()}
              <button onClick={() => setShowClosed(v => !v)} className="ml-auto text-[11px] text-accent hover:underline">
                {showClosed ? '收起' : '展开'}
              </button>
            </div>
            {showClosed && (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-muted border-b border-border/60 bg-elevated/30">
                      {(['名称/代码', '成本', '已实现盈亏', '清仓时间', '资金到账'] as const).map((h, i) => (
                        <th key={h} onClick={() => setClosedSort(cs => ({ col: i, dir: cs.col === i && cs.dir === 'asc' ? 'desc' : 'asc' }))}
                          className="px-3 py-2 text-left font-medium cursor-pointer select-none hover:text-foreground">
                          {h}{closedSort.col === i && <span className="ml-0.5 text-accent">{closedSort.dir === 'asc' ? '↑' : '↓'}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...closedRows].sort((a, b) => {
                      const keys: (keyof HoldingRow)[] = ['symbol', 'avg_cost', 'realized_pnl', 'closed_at', 'settle_date']
                      const k = keys[closedSort.col]
                      const va = (a[k] ?? 0) as string | number
                      const vb = (b[k] ?? 0) as string | number
                      const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : Number(va) - Number(vb)
                      return closedSort.dir === 'asc' ? cmp : -cmp
                    }).map(r => (
                      <tr key={r.symbol} className="border-b border-border/40 cursor-pointer hover:bg-elevated/30"
                        onClick={() => openPreview(r.symbol, r.name || '')}>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            {(() => {
                              const b = REGION_BADGE[r.region ?? (r.symbol.endsWith('.HK') ? 'HK' : r.symbol.endsWith('.US') ? 'US' : 'CN')]
                              return b ? <span className={`px-1 py-px rounded text-[9px] font-bold border ${b.cls}`}>{b.label}</span> : null
                            })()}
                            <span className="text-foreground font-medium">{r.name || '—'}</span>
                            <span className="font-mono text-muted text-xs">{r.symbol}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 tabular-nums text-secondary">{r.avg_cost?.toFixed(3) ?? '—'}</td>
                        <td className={`px-3 py-2 tabular-nums font-medium ${pnlColor(r.realized_pnl)}`}>{fmtMoney(r.realized_pnl)}</td>
                        <td className="px-3 py-2 tabular-nums text-muted text-xs">{r.closed_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums text-xs">
                          {r.symbol.endsWith('.HK') ? (
                            r.settle_date ? (
                              <span className="text-sky-400" title="港股通卖出资金 T+2 交易日交收到账 (卖出时先冻结, 节假日顺延, 按账本交易日历推算)">
                                {r.settle_date}
                              </span>
                            ) : <span className="text-muted">推算中…</span>
                          ) : <span className="text-muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 左: 持仓结构 + 个股盈亏贡献 (上下) | 右: 日收益日历 对齐 */}
        {rows.length > 0 && (
          <div className="flex gap-4 items-stretch">
            <div className="w-[46%] shrink-0 space-y-4">
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
            <div className="flex-1 min-w-0 flex flex-col">
              {/* 日收益: 右列, 与左列等高 */}
              <div className="rounded-card border border-border bg-surface p-4 flex flex-col flex-1 min-h-0">
                <div className="shrink-0 mb-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-foreground">日收益</span>
                    <button onClick={() => window.open(`/api/holdings/export/pnl.csv${activeAcc ? `?account=${encodeURIComponent(activeAcc)}` : ''}`, '_blank')} className="text-[11px] text-accent hover:underline">导出</button>
                  </div>
                  {/* 年份切换: 居中; 右侧显示今日盈亏 */}
                  <div className="flex items-center justify-center gap-2 mt-1.5">
                    <button onClick={() => setYear(y => y - 1)} className="px-1.5 text-secondary hover:text-foreground rotate-90"><ChevronDown className="h-4 w-4" /></button>
                    <span className="text-sm font-semibold tabular-nums text-secondary">{year} 年</span>
                    <button onClick={() => setYear(y => y + 1)} className="px-1.5 text-secondary hover:text-foreground -rotate-90"><ChevronDown className="h-4 w-4" /></button>
                    <span className={`ml-3 text-sm tabular-nums font-semibold ${pnlColor(todayPnl)}`}>今日 {fmtMoney(todayPnl)}</span>
                  </div>
                </div>
                <div className="flex-1 min-h-0">
                  {pnl.isLoading ? <LoadingSkeleton height={300} />
                    : <PnlCalendar daily={pnl.data?.daily ?? []} onPickDay={setDayDetail} fillHeight />}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 月收益: 全宽, 与年收益同宽 */}
        <div className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-foreground">月收益</span>
            <div className="flex items-center gap-2">
              {useLedgerMonthly && historyData.data?.monthly?.find(mm => mm.period === `${year}-${String(monthNow).padStart(2, '0')}`) && (
                <span className="text-xs text-secondary">含本月</span>
              )}
              <span className="text-[11px] text-muted">{useLedgerMonthly ? '账本 · 全部账户' : `本账户${activeAccName ? ` · ${activeAccName}` : ''}`}</span>
            </div>
          </div>
          <MonthlyBars monthly={(historyData.data?.cached && historyData.data.monthly?.length ? historyData.data.monthly : pnl.data?.monthly) ?? []} />
        </div>

        {/* 年收益: 全宽 */}
        <div className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-foreground">年收益</span>
            <div className="flex items-center gap-3">
              {(() => {
                const assets = (pnl.data?.daily ?? []).map(r => r.asset)
                let peak = -Infinity, maxDD = 0
                for (const a of assets) { if (a > peak) peak = a; if (peak > 0 && a < peak) maxDD = Math.max(maxDD, (peak - a) / peak) }
                return maxDD > 0 ? (
                  <span className="text-xs tabular-nums text-muted" title="期间最大回撤">
                    最大回撤 {(maxDD * 100).toFixed(1)}%
                  </span>
                ) : null
              })()}
              {(() => {
                const ledger = historyData.data?.yearly?.find(yy => yy.period === String(year))
                const v = ledger ? ledger.pnl : yearPnl
                return v != null ? (
                  <span className={`text-sm tabular-nums font-medium ${pnlColor(v)}`}>{fmtMoney(v)}{ledger ? '（账本 · 全部账户）' : (activeAccName ? `（本账户 · ${activeAccName}）` : '')}</span>
                ) : null
              })()}
            </div>
          </div>
          <AssetCurve daily={pnl.data?.daily ?? []} benchmark={benchmark.data}
            ledgerCum={historyData.data?.cached && historyData.data.curve?.length
              ? historyData.data.curve.filter(c => c.period.startsWith(String(year)))
              : undefined} />
        </div>
      </div>

      {showTasks && <BgTasksPanel onClose={() => setShowTasks(false)} />}
      {editing && <EditDialog row={editing} onClose={() => setEditing(null)} />}

      {showAdd && <AddDialog onClose={() => setShowAdd(false)} />}
      {showSettings && summary?.data && (
        <HoldingsSettingsDialog
          accountId={activeAcc}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showCookieDialog && (
        <TzzbCookieDialog
          onClose={() => setShowCookieDialog(false)}
          onConfigured={() => { setShowCookieDialog(false); void doSync(false) }}
        />
      )}
      {showImport && (
        <HoldingsImportDialog
          key={dropKey}
          initialImages={dropImages}
          onClose={() => { setShowImport(false); setDropImages(undefined) }}
        />
      )}
      {dayDetail && <DayDetailDialog day={dayDetail} onClose={() => setDayDetail(null)} />}
      {previewSymbol && (
        <StockPreviewDialog
          symbol={previewSymbol}
          name={previewName}
          triggerInfo={undefined}
          markers={previewMarkers}
          markersSource={previewMarkerSrc}
          onClose={() => setPreviewSymbol(null)}
        />
      )}
    </div>
  )
}

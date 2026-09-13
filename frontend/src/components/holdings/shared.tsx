import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { QK } from '@/lib/queryKeys'
import type { EChartsInst } from '@/lib/echarts'

export interface ShotSummary {
  total_asset?: number | null
  total_pnl?: number | null
  day_pnl?: number | null
  day_pnl_pct?: number | null
  market_value?: number | null
  cash_available?: number | null
  cash_withdrawable?: number | null
  position_pct?: number | null
}

/* ================================================================
 * 工具
 * ================================================================ */


export function fmtMoney(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  // 不做万/亿缩写, 完整数字 + 千分位
  return `${sign}${abs.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}


export function fmtPnlPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}


export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}


export const pnlColor = (v: number | null | undefined) =>
  v == null ? 'text-secondary' : v > 0 ? 'text-[#ef4444]' : v < 0 ? 'text-[#22c55e]' : 'text-secondary'


export const REGION_BADGE: Record<string, { label: string; cls: string }> = {
  HK: { label: '港', cls: 'bg-amber-500/12 text-amber-500 border-amber-500/25' },
  US: { label: 'US', cls: 'bg-sky-500/12 text-sky-400 border-sky-500/25' },
}


export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ================================================================
 * 迷你资产曲线 (svg sparkline)
 * ================================================================ */

/* ================================================================
 * 汇总卡 (字体放大 + 金额/百分比红绿)
 * ================================================================ */


export function LoadingSkeleton({ height = 120 }: { height?: number }) {
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


export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-card border border-danger/30 bg-danger/5 px-4 py-3 flex items-center gap-3">
      <span className="text-xs text-danger flex-1">{message}</span>
      <button onClick={onRetry} className="px-3 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground">
        重试
      </button>
    </div>
  )
}


export const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(30,30,36,0.95)', borderColor: '#3f3f46', textStyle: { color: '#e4e4e7', fontSize: 11 },
}


export function EChart({ option, height }: { option: any; height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsInst | null>(null)
  const optionRef = useRef(option)
  optionRef.current = option
  // 挂载: 动态 import 后 init 一次; 数据变化只 setOption (避免 SSE 高频下 dispose/重建)
  useEffect(() => {
    let cancelled = false
    import('@/lib/echarts').then(({ echarts }) => {
      if (cancelled || !ref.current) return
      if (!chartRef.current) chartRef.current = echarts.init(ref.current!)
      chartRef.current.setOption(optionRef.current, true)
    })
    const onResize = () => chartRef.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      cancelled = true
      window.removeEventListener('resize', onResize)
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])
  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])
  return <div ref={ref} style={{ height }} />
}


export function renderMd(text: string): ReactNode[] {
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


export function refreshHoldingsCaches(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: QK.holdings })
  qc.invalidateQueries({ queryKey: QK.holdingsSummary })
  qc.invalidateQueries({ queryKey: QK.holdingsPnl() })
  qc.invalidateQueries({ queryKey: ['watchlist-enriched'] })
}

/** 投资账本连接对话框: 专用 Chrome 登录 (登录一次) + CDP 自动取 Cookie 同步 + 手动粘贴备用 */


/** 全站图表轴/网格统一色 (A3 主题统一) */
export const CHART_AXIS = {
  axisLabel: { fontSize: 10, color: '#a1a1aa' },
  splitLine: { lineStyle: { color: 'rgba(128,128,140,0.15)' } },
}

/** 行内迷你走势 (纯 SVG, 红涨绿跌) */
export function Spark({ closes, width = 76, height = 24 }: { closes: number[]; width?: number; height?: number }) {
  if (!closes || closes.length < 2) return <span className="text-muted text-xs">—</span>
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1
  const pts = closes.map((c, i) => `${(i / (closes.length - 1)) * (width - 4) + 2},${height - 3 - ((c - min) / span) * (height - 6)}`).join(' ')
  const up = closes[closes.length - 1] >= closes[0]
  const color = up ? '#ef4444' : '#22c55e'
  return (
    <svg width={width} height={height} className="inline-block align-middle" data-tip={`${closes[0]} → ${closes[closes.length - 1]}`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" />
      <circle cx={width - 2} cy={height - 3 - ((closes[closes.length - 1] - min) / span) * (height - 6)} r="1.8" fill={color} />
    </svg>
  )
}

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import type { HoldingRow, HoldingsSummary } from '@/lib/api'
import { EChart, TOOLTIP_STYLE, CHART_AXIS, fmtMoney, fmtPnlPct, fmtPct, pnlColor } from './shared'

export function SummaryCard({ s, onSetCap }: {
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
    <div className="rounded-card border border-border bg-gradient-to-br from-surface via-surface to-elevated/50 p-5 md:p-6 shadow-sm">
      <div className="grid grid-cols-2 gap-6 items-end">
        <div>
          <div className="text-xs text-muted flex items-center gap-2">
            总资产
            {s.initial_cap ? <span className="px-1.5 py-px rounded bg-elevated text-[10px] text-secondary">本金 {fmtMoney(s.initial_cap, 0)}</span> : null}
          </div>
          <div className="flex items-baseline gap-3 mt-1.5 flex-wrap">
            <div className={`text-3xl md:text-4xl font-bold tabular-nums tracking-tight ${pnlColor(s.cum_pnl)}`}>{fmtMoney(s.total_asset)}</div>
            {s.day_pnl != null && (
              <span className={`px-1.5 py-0.5 rounded-md text-xs font-semibold tabular-nums ${s.day_pnl >= 0 ? 'bg-[#ef4444]/12 text-[#ef4444]' : 'bg-[#22c55e]/12 text-[#22c55e]'}`}
                title="当日盈亏">
                {s.day_pnl >= 0 ? '▲' : '▼'} {fmtMoney(s.day_pnl)}{s.day_pnl_pct != null ? ` (${fmtPct(s.day_pnl_pct)})` : ''}
              </span>
            )}
          </div>
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
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-5">
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


export function PnlCalendar({ daily, onPickDay, fillHeight }: { daily: { date: string; pnl: number }[]; onPickDay: (d: string) => void; fillHeight?: boolean }) {
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
      {(() => {
        const wins = monthDays.filter(d => d.pnl > 0).length
        const losses = monthDays.filter(d => d.pnl < 0).length
        const best = monthDays.reduce<{ pnl: number } | null>((a, b) => (!a || b.pnl > a.pnl ? b : a), null)
        const worst = monthDays.reduce<{ pnl: number } | null>((a, b) => (!a || b.pnl < a.pnl ? b : a), null)
        return (
          <div className="flex items-center justify-between mt-1.5 px-0.5 text-[10px] text-muted tabular-nums shrink-0">
            <span>盈利 <b className="text-[#ef4444]">{wins}</b> 天 · 亏损 <b className="text-[#22c55e]">{losses}</b> 天</span>
            {best && best.pnl > 0 && <span>最大盈 <span className="text-[#ef4444]">+{fmtMoney(best.pnl, 0)}</span></span>}
            {worst && worst.pnl < 0 && <span>最大亏 <span className="text-[#22c55e]">{fmtMoney(worst.pnl, 0)}</span></span>}
          </div>
        )
      })()}
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


export function MonthlyBars({ monthly, stats }: { monthly: { period: string; pnl: number }[]; stats?: { period: string; wins: number; losses: number; win_rate?: number | null; realized: number }[] }) {
  const statMap = useMemo(() => new Map((stats ?? []).map(x => [x.period, x])), [stats])
  const option = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 20, top: 26, bottom: 28 },
    tooltip: {
      trigger: 'axis', ...TOOLTIP_STYLE,
      formatter: (ps: any[]) => {
        const p = ps[0]
        const st = statMap.get(monthly[p.dataIndex]?.period)
        const rows = [`${p.marker}${p.axisValue}: <b>${fmtMoney(p.value)}</b>`]
        if (st) rows.push(`胜率 <b>${st.win_rate != null ? (st.win_rate * 100).toFixed(0) + '%' : '—'}</b> (${st.wins}胜${st.losses}负)`, `已实现 ${fmtMoney(st.realized)}`)
        return rows.join('<br/>')
      },
    },
    xAxis: { type: 'category', data: monthly.map(r => `${Number(r.period.slice(5))}月`), axisLabel: CHART_AXIS.axisLabel },
    yAxis: { type: 'value', axisLabel: { ...CHART_AXIS.axisLabel, formatter: (v: number) => fmtMoney(v, 0) }, splitLine: CHART_AXIS.splitLine },
    series: [{
      type: 'bar', barMaxWidth: 28,
      data: monthly.map(r => {
        const st = statMap.get(r.period)
        return {
          value: r.pnl,
          itemStyle: { color: r.pnl >= 0 ? '#ef4444' : '#22c55e', borderRadius: [3, 3, 0, 0] },
          label: {
            show: true, position: 'top', fontSize: 9, color: '#a1a1aa',
            formatter: () => {
              const parts: string[] = []
              if (Math.abs(r.pnl) >= 100) parts.push(fmtMoney(r.pnl, 0))
              if (st?.win_rate != null) parts.push(`胜${(st.win_rate * 100).toFixed(0)}%`)
              return parts.join(' · ')
            },
          },
        }
      }),
    }],
  }), [monthly])
  return <EChart option={option} height={200} />
}


export function AssetCurve({ daily, benchmark, ledgerCum }: {
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
      xAxis: { type: 'category', data: dates.map(r => r.slice(5)), axisLabel: { ...CHART_AXIS.axisLabel, fontSize: 9 } },
      yAxis: [
        { type: 'value', scale: true, axisLabel: { ...CHART_AXIS.axisLabel, fontSize: 9, formatter: (v: number) => fmtMoney(v, 0) }, splitLine: CHART_AXIS.splitLine },
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


export function HoldingsPie({ rows }: { rows: HoldingRow[] }) {
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

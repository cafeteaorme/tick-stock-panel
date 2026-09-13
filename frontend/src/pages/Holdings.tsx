import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, Briefcase, Camera, ChevronDown, Loader2, Pencil, PieChart as PieIcon, Plus, RefreshCw, SettingsIcon, Sparkles, TrendingUp, Trash2 } from 'lucide-react'
import { api, type HoldingRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { toast } from '@/components/Toast'
import { StockPreviewDialog } from '@/components/StockPreviewDialog'
import { SummaryCard, PnlCalendar, MonthlyBars, AssetCurve, HoldingsPie } from '@/components/holdings/charts'
import { EditDialog, AddDialog, HoldingsSettingsDialog, TzzbCookieDialog, HoldingsImportDialog, DayDetailDialog, type PickedImage } from '@/components/holdings/dialogs'
import { BgTasksPanel, AiReportPanel } from '@/components/holdings/panels'
import { useTzzbJobs } from '@/lib/useTzzbJobs'
import { fmtMoney, fmtPct, pnlColor, REGION_BADGE, todayIso, LoadingSkeleton, ErrorBanner, Spark } from '@/components/holdings/shared'

type SortKey = 'name' | 'price' | 'change_pct' | 'qty' | 'avg_cost' | 'market_value' | 'float_pnl' | 'day_pnl'
  | 'first_buy' | 'buy_avg' | 'trend'
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
  const previewReqRef = useRef(0)
  const [previewMarkerSrc, setPreviewMarkerSrc] = useState<'tzzb' | 'calc' | undefined>(undefined)
  const openPreview = (sym: string, name: string) => {
    const reqId = ++previewReqRef.current
    setPreviewSymbol(sym)
    setPreviewName(name)
    setPreviewMarkers(undefined)
    setPreviewMarkerSrc(undefined)
    // 持仓股: 拉 B/S 买卖点 (账本真实成交优先, 快照推算兜底); 响应带序号守卫防快速切股竞态
    api.holdingsTrades(sym, activeAcc || undefined).then(d => {
      if (reqId !== previewReqRef.current) return
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
    queryKey: QK.holdingsAccounts,
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
    refetchInterval: 60_000, // 盘中收益日历随行情更新 (此前注释声称轮询但实际未配置)
    placeholderData: (prev) => prev,
  })
  const benchmark = useQuery({
    queryKey: QK.holdingsBenchmark(year, activeAcc),
    queryFn: async () => {
      const st = await api.holdingsSettings()
      return api.holdingsBenchmark(`${year}-01-01`, st.benchmark)
    },
    refetchInterval: 60_000,
    enabled: !!activeAcc,
  })
  // 账本权威月度收益 (投资账本缓存)
  const historyData = useQuery({
    queryKey: QK.holdingsTzzbHistoryData,
    queryFn: api.holdingsTzzbHistoryData,
  })
  // 清仓核对 (账本成交派生 vs 本地已清仓)
  const clearedCheck = useQuery({
    queryKey: QK.holdingsTzzbClearedCheck(activeAcc),
    queryFn: () => api.holdingsTzzbClearedCheck(activeAcc || undefined),
  })
  // 月度胜率 (清仓轮次派生)
  const monthlyStats = useQuery({
    queryKey: QK.holdingsTzzbMonthlyStats,
    queryFn: api.holdingsMonthlyStats,
    staleTime: 5 * 60_000,
  })
  // 行内迷你走势 (近30日收盘, 10min 后端缓存)
  const sparkQ = useQuery({
    queryKey: QK.holdingsSparklines(activeAcc),
    queryFn: () => api.holdingsSparklines(activeAcc || undefined),
    staleTime: 60_000,
  })
  const sparkMap = useMemo(() => new Map(Object.entries(sparkQ.data?.sparklines ?? {})), [sparkQ.data])
  // 止盈止损: 目标价查询 + 现价穿越检测 (每 symbol 每日最多提示一次)
  const targetsQ = useQuery({
    queryKey: QK.holdingsTargets(activeAcc),
    queryFn: () => api.holdingsTargets(activeAcc || undefined),
    staleTime: 60_000,
  })
  const targets = targetsQ.data?.targets ?? {}
  useEffect(() => {
    if (!targetsQ.data) return
    const today = new Date().toISOString().slice(0, 10)
    for (const r of holdings.data?.rows ?? []) {
      const tg = targets[r.symbol]
      const price = r.price
      if (!tg || price == null) continue
      const hitTp = tg.tp != null && price >= tg.tp
      const hitSl = tg.sl != null && price <= tg.sl
      if (!hitTp && !hitSl) continue
      const key = `tf-target-alerted-${r.symbol}-${today}`
      if (localStorage.getItem(key)) continue
      localStorage.setItem(key, '1')
      toast(`${r.name || r.symbol} ${hitTp ? '已达止盈价' : '已破止损价'} ${hitTp ? tg.tp : tg.sl} (现价 ${price})`, hitTp ? 'success' : 'error')
    }
  }, [holdings.data, targetsQ.data])
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
        case 'first_buy': return r.first_buy ?? ''
        case 'trend': return -Infinity
        case 'buy_avg': return r.buy_avg ?? -Infinity
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
    { key: 'trend', label: '趋势' },
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
    { key: 'first_buy', label: '首买日期' },
    { key: 'buy_avg', label: '买入均价' },
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
  // 快速筛选: 市场 / 盈亏方向
  const [filter, setFilter] = useState<'all' | 'CN' | 'HK' | 'US' | 'win' | 'lose'>('all')
  const filteredRows = useMemo(() => {
    if (filter === 'all') return rows
    return rows.filter(r => {
      if (filter === 'win') return (r.float_pnl ?? 0) > 0
      if (filter === 'lose') return (r.float_pnl ?? 0) < 0
      return (r.region ?? 'CN') === filter
    })
  }, [rows, filter])
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
            {(REGION_BADGE[r.region ?? 'CN']) && <span className={`px-1 py-px rounded text-[10px] font-bold border ${REGION_BADGE[r.region ?? 'CN'].cls}`}>{REGION_BADGE[r.region ?? 'CN'].label}</span>}
            <span className="text-foreground font-medium">{r.name || '—'}</span>
            <span className="font-mono text-muted text-xs">{r.symbol}</span>
          </div>
        </td>
      )
      case 'price': return <td className={`px-3 py-2.5 tabular-nums font-medium ${pnlColor(r.change_pct)}`}>{r.price?.toFixed(2) ?? '—'}</td>
      case 'change_pct': return <td className={`px-3 py-2.5 tabular-nums ${pnlColor(r.change_pct)}`}>{fmtPct(r.change_pct)}</td>
      case 'trend': return <td className="px-3 py-2.5"><Spark closes={sparkMap.get(r.symbol) ?? []} /></td>
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
      case 'first_buy': return <td className="px-3 py-2.5 tabular-nums text-muted text-xs">{r.first_buy ?? '—'}</td>
      case 'buy_avg': return <td className="px-3 py-2.5 tabular-nums text-secondary">{r.buy_avg != null ? r.buy_avg.toFixed(3) : '—'}</td>
    }
  }

  // 投资账本同步 (导入 + 刷新共用; 成功/失败都 toast)
  const [tzzbSyncing, setTzzbSyncing] = useState(false)
  const [showCookieDialog, setShowCookieDialog] = useState(false)
  const tzzbStatus = useQuery({
    queryKey: QK.holdingsTzzbStatus,
    queryFn: api.holdingsTzzbStatus,
    refetchInterval: 60_000,
  })

  // 账本后台任务轮询 (完成沿: 精确失效 + toast, 见 lib/useTzzbJobs.ts)
  const jobsQ = useTzzbJobs()

  const doSync = async (isRefresh: boolean) => {
    setTzzbSyncing(true)
    try {
      const res = await api.holdingsTzzbSync(activeAcc || undefined)
      qc.invalidateQueries({ queryKey: QK.holdingsTzzbJobs })
      qc.invalidateQueries({ queryKey: QK.holdingsTzzbStatus })
      // 同步已后台任务化: 数据刷新与成败提示由任务轮询的 running→done 沿触发
      if (res.started) {
        toast(`${isRefresh ? '刷新' : '导入'}已在后台开始，完成后自动提示`, 'success')
      } else if (res.status === 'running') {
        toast('已有同步任务在进行中', 'success')
      } else {
        toast(`${isRefresh ? '刷新' : '导入'}未能启动：${res.message || '未知原因'}`, 'error')
      }
      return res.started
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
                    {fmtMoney(a.day_pnl)}{a.day_pnl_pct != null && <span className="text-[10px]"> {fmtPct(a.day_pnl_pct)}</span>}
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
                qc.invalidateQueries({ queryKey: QK.holdingsAccounts })
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
          <div className="px-4 py-3 border-b border-border flex items-center gap-2 relative flex-wrap">
            <TrendingUp className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold text-foreground">持仓明细</span>
            <span className="text-[10px] text-muted hidden md:inline">点列名排序 · 点行查看个股</span>
            <div className="flex items-center gap-1">
              {([['all', '全部'], ['CN', 'A股'], ['HK', '港股'], ['US', '美股'], ['win', '盈利'], ['lose', '亏损']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setFilter(k)}
                  className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${filter === k ? 'bg-accent/20 text-accent font-medium' : 'text-muted hover:text-secondary hover:bg-elevated'}`}>
                  {label}
                </button>
              ))}
            </div>
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
            <button
              onClick={() => window.open(`/api/holdings/export/holdings.xlsx${activeAcc ? `?account=${encodeURIComponent(activeAcc)}` : ''}`, '_blank')}
              className="text-[11px] text-accent hover:underline"
            >导出 Excel</button>
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
                {filteredRows.map(r => {
                  const concentrated = (r.position_rate ?? 0) > 0.4
                  const tg = targets[r.symbol]
                  const hitTp = tg?.tp != null && r.price != null && r.price >= tg.tp
                  const hitSl = tg?.sl != null && r.price != null && r.price <= tg.sl
                  return (
                    <tr key={r.symbol} className={`border-b border-border/40 hover:bg-elevated/30 transition-colors cursor-pointer ${concentrated ? 'bg-amber-400/[0.07]' : ''} ${hitTp ? 'ring-1 ring-inset ring-[#ef4444]/40' : ''} ${hitSl ? 'ring-1 ring-inset ring-[#22c55e]/40' : ''}`}
                      title={hitTp || hitSl ? `现价${hitTp ? '≥止盈' : '≤止损'} ${hitTp ? tg.tp : tg.sl}` : undefined}
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
                      {(['名称/代码', '成本', '卖出均价', '已实现盈亏', '清仓时间', '资金到账'] as const).map((h, i) => (
                        <th key={h} onClick={() => setClosedSort(cs => ({ col: i, dir: cs.col === i && cs.dir === 'asc' ? 'desc' : 'asc' }))}
                          className="px-3 py-2 text-left font-medium cursor-pointer select-none hover:text-foreground">
                          {h}{closedSort.col === i && <span className="ml-0.5 text-accent">{closedSort.dir === 'asc' ? '↑' : '↓'}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...closedRows].sort((a, b) => {
                      const keys: (keyof HoldingRow)[] = ['symbol', 'avg_cost', 'avg_sell', 'realized_pnl', 'closed_at', 'settle_date']
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
                              return b ? <span className={`px-1 py-px rounded text-[10px] font-bold border ${b.cls}`}>{b.label}</span> : null
                            })()}
                            <span className="text-foreground font-medium">{r.name || '—'}</span>
                            <span className="font-mono text-muted text-xs">{r.symbol}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 tabular-nums text-secondary">{r.avg_cost?.toFixed(3) ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums text-secondary" title="账本成交派生的真实卖出均价">{r.avg_sell?.toFixed(3) ?? '—'}</td>
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
          <MonthlyBars monthly={(historyData.data?.cached && historyData.data.monthly?.length ? historyData.data.monthly : pnl.data?.monthly) ?? []} stats={monthlyStats.data?.stats} />
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

      {showTasks && <BgTasksPanel jobs={jobsQ.data?.jobs ?? []} onClose={() => setShowTasks(false)} />}
      {editing && <EditDialog row={editing} onClose={() => setEditing(null)} account={activeAcc} />}

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

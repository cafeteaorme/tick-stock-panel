import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Check, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'
import { api, type HoldingRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { toast } from '@/components/Toast'
import { Modal } from '@/components/Modal'
import { RecentPhotoStrip, type PickedImage } from '@/components/imports/RecentPhotoStrip'
export type { PickedImage }
import { fmtMoney, fmtPct, pnlColor, todayIso, refreshHoldingsCaches, type ShotSummary } from './shared'

export function EditDialog({ row, onClose, account }: { row: HoldingRow; onClose: () => void; account?: string }) {
  const qc = useQueryClient()
  const targetsQ = useQuery({
    queryKey: QK.holdingsTargets(account),
    queryFn: () => api.holdingsTargets(account || undefined),
    enabled: !!account,
  })
  const curTarget = targetsQ.data?.targets?.[row.symbol]
  const [tp, setTp] = useState<string>('')
  const [sl, setSl] = useState<string>('')
  useEffect(() => {
    if (curTarget) { setTp(curTarget.tp != null ? String(curTarget.tp) : ''); setSl(curTarget.sl != null ? String(curTarget.sl) : '') }
  }, [curTarget])
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
      const latest = await api.holdingsList(false, account)
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
            <div className="border-t border-border/60 pt-2.5 space-y-2">
              <div className="text-[11px] text-muted">止盈 / 止损提醒 (现价穿越时持仓页提示)</div>
              <div className="flex items-center gap-2">
                <label className="flex items-center justify-between gap-2 text-xs flex-1">
                  <span className="text-secondary">止盈价</span>
                  <input type="number" step="any" min="0" value={tp} onChange={e => setTp(e.target.value)} placeholder="未设置"
                    className="w-24 h-8 px-2 rounded-btn bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
                </label>
                <label className="flex items-center justify-between gap-2 text-xs flex-1">
                  <span className="text-secondary">止损价</span>
                  <input type="number" step="any" min="0" value={sl} onChange={e => setSl(e.target.value)} placeholder="未设置"
                    className="w-24 h-8 px-2 rounded-btn bg-base border border-border text-right tabular-nums text-foreground focus:outline-none focus:border-accent/50" />
                </label>
                <button
                  onClick={() => {
                    api.holdingsSetTarget(row.symbol, Number(tp) || null, Number(sl) || null, account || undefined)
                      .then(() => { qc.invalidateQueries({ queryKey: ['holdings-targets'] }); toast('止盈止损已保存', 'success') })
                      .catch(() => toast('保存失败', 'error'))
                  }}
                  className="h-8 px-3 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground"
                >保存</button>
              </div>
            </div>
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


export function AddDialog({ onClose }: { onClose: () => void }) {
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


export function ShotSummaryBlock({
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
            <div className="text-[10px] text-muted truncate">{label}</div>
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


export function HistoryCacheBlock() {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: QK.holdingsTzzbHistory,
    queryFn: api.holdingsTzzbHistoryStatus,
  })
  const [fetching, setFetching] = useState(false)
  const fetchNow = async () => {
    setFetching(true)
    try {
      const res = await api.holdingsTzzbHistoryFetch()
      toast(res.message, res.ok ? 'success' : 'error')
      qc.invalidateQueries({ queryKey: QK.holdingsTzzbHistory })
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


export function HkRateAuto({ setHkRate }: { setHkRate: (v: string) => void }) {
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


export function HoldingsSettingsDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: QK.holdingsSettings, queryFn: api.holdingsSettings })
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
      qc.invalidateQueries({ queryKey: QK.holdingsSettings })
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


export function TzzbCookieDialog({ onClose, onConfigured }: { onClose: () => void; onConfigured: () => void }) {
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
      if (res.started) {
        toast('同步已在后台开始，完成后自动提示', 'success')
        onConfigured()
      } else {
        toast('已有同步任务在进行中', 'success')
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
    <Modal
      onClose={onClose}
      ariaLabel="连接投资账本"
      panelClassName="w-[28rem] max-w-[94vw] max-h-[88vh] flex flex-col rounded-card border border-border bg-surface shadow-2xl"
    >
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
    </Modal>
  )
}


export function HoldingsImportDialog({ onClose, initialImages }: { onClose: () => void; initialImages?: PickedImage[] }) {
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
          if (capN > 0 && capN !== (await qc.fetchQuery({ queryKey: QK.holdingsSummaryBase, queryFn: () => api.holdingsSummary() })).initial_cap) patch.initial_cap = capN
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


export function DayDetailDialog({ day, onClose, account }: { day: string; onClose: () => void; account?: string }) {
  const q = useQuery({
    queryKey: ['holdings-pnl-day', day, account],
    queryFn: () => api.holdingsPnlDay(day, account || undefined),
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

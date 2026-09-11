import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api, type MinuteKlineRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { EChartsIntraday, type IntradayBSMarker } from '@/components/EChartsIntraday'

interface Props {
  symbol: string
  date: string | null
  height?: number
  prevClose?: number
  className?: string
  onPriceHover?: (price: number | null) => void
  /** 自动刷新间隔(ms)。undefined/0 = 不轮询(默认)。个股对话框盘中实时刷新时传入。 */
  refetchIntervalMs?: number
}

export function StockIntradayChart({
  symbol,
  date,
  height = 520,
  prevClose,
  className,
  onPriceHover,
  refetchIntervalMs,
}: Props) {
  const qc = useQueryClient()
  const [minuteDismissed, setMinuteDismissed] = useState(false)

  // 港美股分时走腾讯免费接口 (当日); A股走本地分钟K + TickFlow
  const region: 'CN' | 'HK' | 'US' = symbol.endsWith('.HK') ? 'HK' : symbol.endsWith('.US') ? 'US' : 'CN'
  const isHkUs = region !== 'CN'

  const minute = useQuery({
    queryKey: QK.klineMinute(symbol, date ?? ''),
    queryFn: () => api.klineMinute(symbol, date ?? undefined),
    enabled: !!symbol && !!date,
    // 港美股: 已有数据时 60s 轮询 (后台也在刷新本地, 命中本地低延迟); A股沿用外部传入
    refetchInterval: refetchIntervalMs ?? (isHkUs ? 60_000 : undefined),
  })

  // 真实成交 (投资账本): 当日成交按分钟聚合为 B/S 标记
  const tzzbTrades = useQuery({
    queryKey: ['holdings-tzzb-trades', symbol],
    queryFn: () => api.holdingsTzzbTradesList(symbol),
    enabled: !!symbol,
    staleTime: 60_000,
  })
  const bsMarkers: IntradayBSMarker[] = useMemo(() => {
    const all = tzzbTrades.data?.trades ?? []
    const day = all.filter(t => t.date === date)
    const byMin = new Map<string, { side: 'B' | 'S'; pq: number; q: number; n: number }>()
    for (const t of day) {
      if (t.bs !== 'B' && t.bs !== 'S') continue
      const hhmm = (t.time ?? '').slice(0, 2) + ':' + (t.time ?? '').slice(2, 4)
      const cur = byMin.get(hhmm) ?? { side: t.bs, pq: 0, q: 0, n: 0 }
      cur.pq += (t.price ?? 0) * (t.qty ?? 0)
      cur.q += t.qty ?? 0
      cur.n += 1
      byMin.set(hhmm, cur)
    }
    return [...byMin.entries()].map(([time, v]) => ({
      time,
      side: v.side,
      price: v.q ? Math.round((v.pq / v.q) * 1000) / 1000 : 0,
      qty: v.q,
    })).sort((a, b) => a.time.localeCompare(b.time))
  }, [tzzbTrades.data, date])

  const fetchMinute = useMutation({
    mutationFn: () => api.syncMinuteSingle(symbol),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kline-minute', symbol] })
      qc.invalidateQueries({ queryKey: QK.klineMinute(symbol, date ?? '') })
      setMinuteDismissed(false)
    },
  })

  const minuteRows: MinuteKlineRow[] = useMemo(() => minute.data?.rows ?? [], [minute.data?.rows])
  // source=none 表示本地无数据且 TickFlow 也拉不到 (停牌/复牌延迟/非交易日)
  // 此时不弹"是否获取"询问窗, 只做静态提示, 避免误导用户去拉明知拉不到的数据
  const sourceIsNone = minute.data?.source === 'none'
  // 指数分钟K无本地存储且不支持落库获取 (后端 sync_minute_single 显式拒绝), 不显示获取按钮
  const isIndex = minute.data?.asset_type === 'index'

  useEffect(() => {
    setMinuteDismissed(false)
    onPriceHover?.(null)
  }, [date, onPriceHover])

  if (!symbol || !date) return null

  return (
    <div className={className} style={{ height, flexShrink: 0 }}>
      {minute.isLoading && <div className="text-xs text-muted py-2">分时加载中…</div>}
      {!minute.isLoading && minuteRows.length === 0 && (
        <>
          {fetchMinute.isPending ? (
            <div className="flex items-center justify-center h-full gap-2 text-xs text-accent">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>正在获取分钟K数据…</span>
            </div>
          ) : isHkUs ? (
            // 港美股: 腾讯免费分时仅提供当日, 无 5 日分钟K同步入口
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="text-xs text-muted">当日暂无分时数据（休市、未开盘或数据源未提供）</div>
              <button
                onClick={() => minute.refetch()}
                className="px-4 py-1.5 rounded-btn bg-elevated text-secondary text-xs font-medium hover:bg-elevated/80 transition-colors duration-150"
              >
                重新获取
              </button>
            </div>
          ) : isIndex ? (
            // 指数: 分钟K仅支持实时读取, 无落库获取入口
            <div className="flex items-center justify-center h-full text-xs text-muted">指数暂无分钟数据</div>
          ) : sourceIsNone ? (
            // 数据源确认无此日分钟数据 (停牌/复牌延迟等): 静态提示 + 保留重试
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="text-xs text-muted">该日暂无分钟数据（数据源未提供）</div>
              <button
                onClick={() => fetchMinute.mutate()}
                className="px-4 py-1.5 rounded-btn bg-elevated text-secondary text-xs font-medium hover:bg-elevated/80 transition-colors duration-150"
              >
                重新获取
              </button>
            </div>
          ) : minuteDismissed ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="text-xs text-muted">暂无分钟数据</div>
              <button
                onClick={() => setMinuteDismissed(false)}
                className="px-4 py-1.5 rounded-btn bg-accent/90 text-base text-xs font-medium hover:bg-accent transition-colors duration-150"
              >
                获取分钟K
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="text-sm text-foreground">是否立即获取最近5日分钟K？</div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => fetchMinute.mutate()}
                  className="px-4 py-1.5 rounded-btn bg-accent/90 text-base text-xs font-medium hover:bg-accent transition-colors duration-150"
                >
                  确定
                </button>
                <button
                  onClick={() => setMinuteDismissed(true)}
                  className="px-4 py-1.5 rounded-btn bg-elevated text-secondary text-xs hover:bg-elevated/80 transition-colors duration-150"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {minuteRows.length > 0 && (
        <EChartsIntraday
          data={minuteRows}
          height={height}
          prevClose={prevClose}
          date={date}
          priceLimit={minute.data?.price_limit ?? undefined}
          onPriceHover={onPriceHover}
          region={region}
          bsMarkers={bsMarkers}
        />
      )}
    </div>
  )
}

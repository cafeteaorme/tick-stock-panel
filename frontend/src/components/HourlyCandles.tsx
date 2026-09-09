/** 60 分线: 由当日 1 分钟数据聚合为 60 分钟蜡烛 */
import { useQuery } from '@tanstack/react-query'
import { EChartsCandlestick, type OHLC } from '@/components/EChartsCandlestick'
import { api } from '@/lib/api'

export function HourlyCandles({ symbol, height = 420 }: { symbol: string; height?: number }) {
  const minute = useQuery({
    queryKey: ['holdings-minute', symbol],
    queryFn: () => api.klineMinute(symbol),
    refetchInterval: 60_000,
  })
  if (minute.isLoading) return null
  const rows = minute.data?.rows ?? []
  if (rows.length === 0) return null

  // 按 60 分钟聚合 OHLC
  const buckets: Record<string, OHLC[]> = {}
  for (const r of rows) {
    const dt = String(r.datetime)
    const hhmm = dt.slice(11, 16)
    const hour = hhmm.slice(0, 2)
    const key = `${hour}:00-${Number(hour) + 1}:00`
    ;(buckets[key] ??= []).push({
      date: hhmm,
      open: r.open, high: r.high, low: r.low, close: r.close,
      volume: r.volume,
    })
  }
  const bars: OHLC[] = Object.keys(buckets).sort().map(key => {
    const arr = buckets[key]
    return {
      date: key,
      open: arr[0].open,
      high: Math.max(...arr.map(b => b.high)),
      low: Math.min(...arr.map(b => b.low)),
      close: arr[arr.length - 1].close,
      volume: arr.reduce((s, b) => s + (b.volume ?? 0), 0),
    }
  })
  return <EChartsCandlestick data={bars} height={height} symbol={symbol} showInfoBar={false} showMarkers={false} visibleBars={bars.length} />
}

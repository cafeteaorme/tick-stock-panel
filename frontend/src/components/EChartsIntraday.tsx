import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import {
  LineChart, BarChart, CandlestickChart, ScatterChart, PieChart,
} from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent,
  MarkPointComponent, MarkLineComponent, GraphicComponent, AxisPointerComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart, BarChart, CandlestickChart, ScatterChart, PieChart,
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent,
  MarkPointComponent, MarkLineComponent, GraphicComponent, AxisPointerComponent,
  CanvasRenderer,
])

import type { EChartsOption } from 'echarts'
import type { EChartsInst } from '@/lib/echarts'
import type { MinuteKlineRow, PriceLimitInfo } from '@/lib/api'
import { BULL, BEAR, useChartTheme, type ChartTheme } from '@/lib/theme'

type YMode = 'adaptive' | 'limit'

// 序列颜色 (双主题通用); 画布轴/网格/十字线等主题相关色走 ChartTheme
const THEME = {
  line: '#3B82F6',
  areaFill: 'rgba(59,130,246,0.40)',
  avgLine: '#F59E0B',
  volUp: 'rgba(240,68,56,0.6)',
  volDown: 'rgba(18,183,106,0.6)',
}

/** 真实成交 B/S 标记 (投资账本, time 为 HH:MM 会话时间) */
export interface IntradayBSMarker {
  time: string
  side: 'B' | 'S'
  price: number
  qty?: number
}

interface Props {
  data: MinuteKlineRow[]
  height?: number
  prevClose?: number
  date?: string
  priceLimit?: PriceLimitInfo
  onPriceHover?: (price: number | null) => void
  showLimitLines?: boolean
  showAvgLine?: boolean
  /** 市场区域: 时间轴/成交量单位按区域切换 (CN 9:30-15:00 / HK 9:30-16:00 / US 美东 9:30-16:00) */
  region?: 'CN' | 'HK' | 'US'
  /** 真实成交 B/S 点 (按分钟聚合) */
  bsMarkers?: IntradayBSMarker[]
}

type Region = 'CN' | 'HK' | 'US'

function fmtTime(dt: string, region: Region): string {
  const match = dt.match(/(\d{2}):(\d{2})/)
  if (!match) return dt.slice(11, 16)
  // A股分钟K的 datetime 以 UTC 存储, 展示需 +8; 港美股分时存的是当地会话时间, 原样使用
  const h = region === 'CN' ? (parseInt(match[1]) + 8) % 24 : parseInt(match[1])
  return `${String(h).padStart(2, '0')}:${match[2]}`
}

function computeAvgPrice(data: MinuteKlineRow[], region: Region): number[] {
  // 分时均线 = 累计成交额 / 累计成交量。A股 volume 单位为手(×100), 港美股为股
  const result: number[] = []
  let sumAmt = 0
  let sumVol = 0
  for (const d of data) {
    sumAmt += d.amount
    sumVol += d.volume * (region === 'CN' ? 100 : 1)
    result.push(sumVol > 0 ? sumAmt / sumVol : d.close)
  }
  return result
}

function fmtAmt(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(0)}万`
  return v.toFixed(0)
}

function isValidPrice(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/** 生成全天分时时间刻度, 每分钟一个点。CN: 9:30-11:30+13:00-15:00 (242); HK: 9:30-12:00+13:00-16:00 (331); US: 9:30-16:00 (391) */
function generateFullDayTimes(region: Region): string[] {
  const times: string[] = []
  const push = (h1: number, m1: number, h2: number, m2: number) => {
    for (let t = h1 * 60 + m1; t <= h2 * 60 + m2; t++) {
      times.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`)
    }
  }
  if (region === 'CN') {
    push(9, 30, 11, 30)
    push(13, 0, 15, 0)
  } else if (region === 'HK') {
    push(9, 30, 12, 0)
    push(13, 0, 16, 0)
  } else {
    push(9, 30, 16, 0)
  }
  return times
}

const FULL_DAY_TIMES_BY_REGION: Record<Region, string[]> = {
  CN: generateFullDayTimes('CN'),
  HK: generateFullDayTimes('HK'),
  US: generateFullDayTimes('US'),
}

/** 各区域 x 轴标签: 首盘 / 午休分界(合并) / 中段 / 尾盘 */
const X_LABELS_BY_REGION: Record<Region, Record<number, string>> = {
  CN: { 0: '9:30', 60: '10:30', 120: '11:30/13:00', 181: '14:00', 241: '15:00' },
  HK: { 0: '9:30', 90: '11:00', 150: '12:00/13:00', 240: '14:00', 330: '16:00' },
  US: { 0: '9:30', 120: '11:30', 195: '12:45', 270: '14:00', 390: '16:00' },
}

/** 计算实际涨跌停价 (四舍五入到2位小数) 和实际涨跌停幅度 */
function getLimitPrices(prevClose: number, priceLimit?: PriceLimitInfo): {
  limitUp: number      // 涨停价 (四舍五入)
  limitDown: number    // 跌停价 (四舍五入)
  upPct: number        // 实际涨停幅度 (如 9.97)
  downPct: number      // 实际跌停幅度 (如 -9.97)
} {
  const pct = priceLimit && Number.isFinite(priceLimit.rate) ? priceLimit.rate : 0.10
  const rawUp = prevClose * (1 + pct)
  const rawDown = prevClose * (1 - pct)
  // A股涨跌停价四舍五入到分 (2位小数)
  const limitUp = isValidPrice(priceLimit?.limit_up)
    ? priceLimit.limit_up
    : Math.round(rawUp * 100) / 100
  const limitDown = isValidPrice(priceLimit?.limit_down)
    ? priceLimit.limit_down
    : Math.round(rawDown * 100) / 100
  const upPct = (limitUp - prevClose) / prevClose * 100
  const downPct = (limitDown - prevClose) / prevClose * 100
  return { limitUp, limitDown, upPct, downPct }
}

function buildOption(data: MinuteKlineRow[], prevClose: number | undefined, avgPrices: number[], lineColor: string, areaColor: string, yMode: YMode, ct: ChartTheme, priceLimit?: PriceLimitInfo, showLimitLines = true, showAvgLine = true, region: Region = 'CN', bsMarkers?: IntradayBSMarker[]): EChartsOption {
  // 将数据映射到全天时间轴上的正确位置
  const fullDayTimes = FULL_DAY_TIMES_BY_REGION[region]
  const timeIndexMap = new Map(fullDayTimes.map((t, i) => [t, i]))
  const closes = new Array(fullDayTimes.length).fill(null) as (number | null)[]
  const highs = new Array(fullDayTimes.length).fill(null) as (number | null)[]
  const lows = new Array(fullDayTimes.length).fill(null) as (number | null)[]
  const avgData = new Array(fullDayTimes.length).fill(null) as (number | null)[]
  const volumes = new Array(fullDayTimes.length).fill(null) as (any | null)[]

  const volNeutral = 'rgba(161,161,170,0.5)'
  for (let i = 0; i < data.length; i++) {
    const timeKey = fmtTime(data[i].datetime, region)
    const idx = timeIndexMap.get(timeKey)
    if (idx !== undefined) {
      closes[idx] = data[i].close
      highs[idx] = data[i].high
      lows[idx] = data[i].low
      avgData[idx] = avgPrices[i]
      volumes[idx] = {
        value: data[i].volume,
        itemStyle: {
          color: data[i].close > data[i].open ? THEME.volUp : data[i].close < data[i].open ? THEME.volDown : volNeutral,
        },
      }
    }
  }

  const areaStyle: any = {
    color: {
      type: 'linear',
      x: 0, y: 0, x2: 0, y2: 1,
      colorStops: [
        { offset: 0, color: areaColor },
        { offset: 1, color: 'rgba(0,0,0,0)' },
      ],
    },
  }

  // 真实成交 B/S 散点: time(会话 HH:MM) → 全日轴索引, 值取成交价
  const bsSeriesData = (bsMarkers ?? [])
    .map(m => {
      const idx = timeIndexMap.get(m.time)
      if (idx === undefined || !isValidPrice(m.price)) return null
      return {
        value: [idx, m.price],
        symbol: m.side === 'B' ? 'triangle' : 'diamond',
        symbolSize: 13,
        symbolOffset: m.side === 'B' ? [0, 6] : [0, -6],
        itemStyle: { color: m.side === 'B' ? BULL : BEAR, borderColor: 'rgba(255,255,255,0.85)', borderWidth: 1 },
        label: {
          show: true, position: (m.side === 'B' ? 'bottom' : 'top') as 'bottom' | 'top', distance: 2,
          formatter: m.side, fontSize: 10, fontWeight: 'bold' as const,
          color: m.side === 'B' ? BULL : BEAR,
        },
        _tip: `${m.side === 'B' ? '买入' : '卖出'} ${m.qty ?? ''}${m.qty != null ? ' 股 @ ' : '@ '}${m.price}`,
      }
    })
    .filter(Boolean)

  const markLineData: any[] = []
  if (prevClose != null) {
    markLineData.push({
      yAxis: prevClose,
      lineStyle: { color: ct.crosshair, type: 'dashed', width: 1 },
      label: { show: false },
      symbol: 'none',
    })
  }

  let yMin: number | undefined
  let yMax: number | undefined
  let maxDiff = 0
  if (isValidPrice(prevClose) && data.length > 0) {
    const priceArrays = showAvgLine ? [closes, highs, lows, avgData] : [closes, highs, lows]
    for (const arr of priceArrays) {
      for (const v of arr) {
        if (!isValidPrice(v)) continue
        const diff = Math.abs(v - prevClose)
        if (diff > maxDiff) maxDiff = diff
      }
    }

  // 港美股无涨跌停: 涨跌停线与 limit 模式仅 A股生效
  const showLimitEff = showLimitLines && region === 'CN'
  const yModeEff: YMode = region === 'CN' ? yMode : 'adaptive'

    if (showLimitEff && yModeEff === 'limit') {
      const { limitUp, limitDown } = getLimitPrices(prevClose, priceLimit)
      const limitDiffUp = limitUp - prevClose
      const limitDiffDown = prevClose - limitDown
      const limitDiff = Math.max(limitDiffUp, limitDiffDown)
      // 涨跌停模式: Y 轴按实际涨跌停价
      maxDiff = limitDiff
      yMin = prevClose - maxDiff
      yMax = prevClose + maxDiff
      // 加 markLine 标注涨停价和跌停价 (仅虚线, 不显示文字)
      markLineData.push(
        {
          yAxis: limitUp,
          lineStyle: { color: 'rgba(199,64,64,0.4)', type: 'dashed', width: 1 },
          label: { show: false },
          symbol: 'none',
        },
        {
          yAxis: limitDown,
          lineStyle: { color: 'rgba(45,155,101,0.4)', type: 'dashed', width: 1 },
          label: { show: false },
          symbol: 'none',
        },
      )
    } else {
      // 自适应模式: Y 轴按实际涨跌幅对称, 但不超出实际涨跌停范围
      if (showLimitEff) {
        const { limitUp, limitDown } = getLimitPrices(prevClose, priceLimit)
        const limitDiff = Math.max(limitUp - prevClose, prevClose - limitDown)
        maxDiff = Math.min(maxDiff, limitDiff)
      }
      if (!showLimitEff && maxDiff > 0) {
        maxDiff *= 1.1
      }
      // 至少保证一个可视范围 (防止数据平时 maxDiff=0)。指数不使用涨跌停范围，最小范围要更紧，否则低波动指数会被压成横线。
      const minDiff = showLimitEff ? prevClose * 0.01 : prevClose * 0.001
      if (maxDiff < minDiff) maxDiff = minDiff
      yMin = prevClose - maxDiff
      yMax = prevClose + maxDiff
    }
  }

  // x 轴标签按区域: 首盘 / 午休分界(合并) / 中段 / 尾盘
  const xAxisLabelMap = X_LABELS_BY_REGION[region]
  const xAxisLabelFormatter = (_value: string, idx: number) => {
    return xAxisLabelMap[idx] ?? ''
  }

  return {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'transparent',
      borderWidth: 0,
      textStyle: { fontSize: 0 },
      formatter: () => '',
      axisPointer: {
        type: 'cross',
        label: {
          show: true,
          backgroundColor: ct.tooltipBg,
          borderColor: ct.tooltipBorder,
          borderWidth: 1,
          padding: [2, 5],
          color: ct.tooltipText,
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
        },
        crossStyle: { color: ct.crosshair, type: 'dashed', width: 1 },
        lineStyle: { color: ct.crosshair, type: 'dashed', width: 1 },
      },
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
    },
    grid: [
      { left: 60, right: 55, top: 24, bottom: '28%' },
      { left: 60, right: 55, top: '74%', bottom: 20 },
    ],
    xAxis: [
      {
        type: 'category',
        data: fullDayTimes,
        boundaryGap: false,
        axisPointer: {
          show: true,
          lineStyle: { color: ct.crosshair, type: 'dashed', width: 1 },
          label: {
            show: true,
            backgroundColor: ct.tooltipBg,
            borderColor: ct.tooltipBorder,
            borderWidth: 1,
            padding: [2, 4],
            color: ct.tooltipText,
            fontSize: 10,
            fontFamily: 'JetBrains Mono, monospace',
            formatter: (params: any) => {
              return params.value ?? ''
            },
          },
        },
        axisLine: { show: false },
        axisLabel: {
          color: ct.text,
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
          formatter: xAxisLabelFormatter,
          interval: 0,
        },
        axisTick: { show: false },
        splitLine: {
          show: true,
          lineStyle: { color: ct.grid },
        },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: fullDayTimes,
        boundaryGap: false,
        axisLine: { show: false },
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: 'value',
        min: yMin,
        max: yMax,
        interval: maxDiff || undefined,
        splitArea: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: ct.grid } },
        axisPointer: {
          label: {
            formatter: (params: any) => {
              const v = params.value
              return typeof v === 'number' ? v.toFixed(2) : ''
            },
          },
        },
        axisLabel: {
          color: ct.text,
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
          formatter: (v: number) => v.toFixed(2),
        },
      },
      {
        scale: true,
        gridIndex: 1,
        splitNumber: 2,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
      },
      ...(isValidPrice(prevClose) && yMin != null && yMax != null ? [{
        type: 'value' as const,
        position: 'right' as const,
        gridIndex: 0,
        min: yMin,
        max: yMax,
        interval: maxDiff || undefined,
        splitArea: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisPointer: {
          label: {
            formatter: (params: any) => {
              const v = params.value
              if (typeof v !== 'number') return ''
              const pct = (v - prevClose) / prevClose * 100
              if (Math.abs(pct) < 0.01) return '0.00%'
              return (pct > 0 ? '+' : '') + pct.toFixed(2) + '%'
            },
          },
        },
        axisLabel: {
          color: ct.text,
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
          formatter: (v: number) => {
            const pct = (v - prevClose) / prevClose * 100
            if (Math.abs(pct) < 0.01) return '0.00%'
            return (pct > 0 ? '+' : '') + pct.toFixed(2) + '%'
          },
        },
      }] : []),
    ],
    series: [
      {
        name: '价格',
        type: 'line',
        data: closes,
        smooth: false,
        symbol: 'none',
        cursor: 'crosshair',
        lineStyle: { width: 1.2, color: lineColor },
        areaStyle,
        connectNulls: true,
        markLine: markLineData.length > 0 ? { symbol: 'none', data: markLineData, animation: false, silent: true } : undefined,
      },
      ...(showAvgLine ? [{
        name: '均价',
        type: 'line' as const,
        data: avgData,
        smooth: false,
        symbol: 'none',
        cursor: 'crosshair',
        lineStyle: { width: 1, color: THEME.avgLine },
        connectNulls: true,
      }] : []),
      {
        name: '成交量',
        type: 'bar',
        data: volumes,
        xAxisIndex: 1,
        yAxisIndex: 1,
        cursor: 'crosshair',
      },
      ...(bsSeriesData.length > 0 ? [{
        name: '真实成交',
        type: 'scatter' as const,
        data: bsSeriesData,
        z: 20,
        cursor: 'pointer',
        tooltip: {
          trigger: 'item' as const,
          formatter: (p: any) => p.data?._tip ?? '',
          backgroundColor: 'rgba(24,24,27,0.92)',
          borderWidth: 0,
          textStyle: { color: '#e4e4e7', fontSize: 11 },
        },
      }] : []),
    ],
  }
}

export function EChartsIntraday({ data, height = 320, prevClose, date, priceLimit, onPriceHover, showLimitLines = true, showAvgLine = true, region = 'CN', bsMarkers }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsInst | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  const moRef = useRef<MutationObserver | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const onPriceHoverRef = useRef(onPriceHover)
  onPriceHoverRef.current = onPriceHover
  // 全日索引 → 数据数组索引 的映射 (ref 避免重建 chart)
  const fullDayToDataIdx = useRef<Map<number, number>>(new Map())

  const [infoIdx, setInfoIdx] = useState(data.length - 1)
  const [yMode, setYMode] = useState<YMode>('adaptive')
  const ct = useChartTheme()
  const avgPrices = useMemo(() => computeAvgPrice(data, region), [data, region])

  // 分时线颜色：基于最新价 vs 昨收
  const lastClose = data.length > 0 ? data[data.length - 1].close : null
  const lineIsUp = lastClose != null && prevClose != null ? lastClose > prevClose : true
  const lineIsFlat = lastClose != null && prevClose != null ? lastClose === prevClose : false
  const lineColor = lineIsFlat ? '#A1A1AA' : lineIsUp ? BULL : BEAR
  const areaFill = lineIsFlat ? 'rgba(180,180,190,0.40)' : lineIsUp ? 'rgba(199,64,64,0.40)' : 'rgba(34,197,94,0.40)'

  useEffect(() => {
    setInfoIdx(data.length - 1)
  }, [data.length])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let chart = chartRef.current
    if (!chart) {
      chart = echarts.init(el, undefined, { renderer: 'canvas' })
      chartRef.current = chart
      // 强制 canvas 使用十字光标，覆盖 ECharts 默认的 pointer
      const forceCursor = () => {
        const canvases = el.querySelectorAll('canvas')
        canvases.forEach(c => { c.style.setProperty('cursor', 'crosshair', 'important') })
      }
      forceCursor()
      // MutationObserver: ECharts 内部可能重建/修改 canvas 属性，持续强制 cursor
      const mo = new MutationObserver(forceCursor)
      mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
      moRef.current = mo
      roRef.current = new ResizeObserver(() => {
        chart!.resize()
        forceCursor()
      })
      roRef.current.observe(el)

      chart.on('updateAxisPointer', (event: any) => {
        const axesInfo = event.axesInfo
        if (!axesInfo) return
        for (const info of Object.values(axesInfo)) {
          const val = (info as any)?.value
          if (val == null) continue
          const fullDayIdx = typeof val === 'number' ? val : -1
          if (fullDayIdx >= 0) {
            const dataIdx = fullDayToDataIdx.current.get(fullDayIdx) ?? -1
            setInfoIdx(dataIdx)
            const d = dataRef.current
            if (dataIdx >= 0 && dataIdx < d.length) {
              onPriceHoverRef.current?.(d[dataIdx].close)
            }
            return
          }
        }
      })

      chart.on('globalout', () => {
        onPriceHoverRef.current?.(null)
      })
    }

    if (data.length > 0) {
      // 构建全日索引 → 数据索引 的映射
      const timeIndexMap = new Map(FULL_DAY_TIMES_BY_REGION[region].map((t, i) => [t, i]))
      const mapping = new Map<number, number>()
      for (let i = 0; i < data.length; i++) {
        const timeKey = fmtTime(data[i].datetime, region)
        const fullDayIdx = timeIndexMap.get(timeKey)
        if (fullDayIdx !== undefined) {
          mapping.set(fullDayIdx, i)
        }
      }
      fullDayToDataIdx.current = mapping

      chart.setOption(buildOption(data, prevClose, avgPrices, lineColor, areaFill, yMode, ct, priceLimit, showLimitLines, showAvgLine, region, bsMarkers), true)
    } else {
      chart.clear()
    }
  }, [data, prevClose, height, lineColor, areaFill, yMode, ct, priceLimit, showLimitLines, showAvgLine, region, bsMarkers])

  useEffect(() => {
    return () => {
      chartRef.current?.off('updateAxisPointer')
      chartRef.current?.off('globalout')
      moRef.current?.disconnect()
      roRef.current?.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
      moRef.current = null
      roRef.current = null
    }
  }, [])

  const d = infoIdx >= 0 && infoIdx < data.length ? data[infoIdx] : null
  const avg = d != null ? avgPrices[infoIdx] : null
  const chg = d && prevClose != null ? d.close - prevClose : null
  const isUp = chg != null ? chg > 0 : true
  const isFlat = chg != null ? chg === 0 : false
  const priceClr = isFlat ? '#A1A1AA' : isUp ? BULL : BEAR

  return (
    <div className="w-full">
      {/* 按钮行: 切换式按钮组, 居右 */}
      {showLimitLines && region === 'CN' && <div className="flex items-center justify-end px-1 pb-0.5">
        <div className="inline-flex items-center rounded bg-elevated overflow-hidden">
          <button
            onClick={() => setYMode('adaptive')}
            className={`px-2.5 py-0.5 text-[10px] font-mono cursor-pointer transition-colors ${
              yMode === 'adaptive'
                ? 'bg-accent/20 text-accent'
                : 'text-muted hover:text-secondary'
            }`}
          >
            自适应
          </button>
          <div className="w-px h-3 bg-border/40" />
          <button
            onClick={() => setYMode('limit')}
            className={`px-2.5 py-0.5 text-[10px] font-mono cursor-pointer transition-colors ${
              yMode === 'limit'
                ? 'bg-accent/20 text-accent'
                : 'text-muted hover:text-secondary'
            }`}
          >
            涨跌停
          </button>
        </div>
      </div>}
      <div style={{ backgroundColor: ct.infoBarBg }}>
        {/* 第一行: 日期 + OHLC */}
        <div className="flex items-center gap-x-2 px-2 font-mono text-[11px] select-none flex-wrap" style={{ height: 20 }}>
          {!d && <span className="text-muted">—</span>}
          {d && (
            <>
              {date && <span className="text-muted">{date}</span>}
              <span className="text-muted">开</span>
              <span style={{ color: priceClr }}>{d.open.toFixed(2)}</span>
              <span className="text-muted">高</span>
              <span style={{ color: priceClr }}>{d.high.toFixed(2)}</span>
              <span className="text-muted">低</span>
              <span style={{ color: priceClr }}>{d.low.toFixed(2)}</span>
              <span className="text-muted">收</span>
              <span style={{ color: priceClr }} className="font-semibold">{d.close.toFixed(2)}</span>
            </>
          )}
        </div>
        {/* 第二行: 价格+均价+量+额 */}
        <div className="flex items-center gap-x-4 px-2 font-mono text-[11px] select-none" style={{ height: 20 }}>
          {d && (
            <>
              <span className="flex items-center gap-x-1">
                <span style={{ display: 'inline-block', width: 14, height: 2, background: priceClr }} />
                <span style={{ color: priceClr }}>{d.close.toFixed(2)}</span>
              </span>
              {showAvgLine && <span className="flex items-center gap-x-1">
                <span style={{ display: 'inline-block', width: 14, height: 2, background: THEME.avgLine }} />
                <span style={{ color: THEME.avgLine }}>{avg?.toFixed(2)}</span>
              </span>}
              <span className="text-muted">量</span>
              <span className="text-secondary">{d.volume.toFixed(0)}</span>
              <span className="text-muted">额</span>
              <span className="text-secondary">{fmtAmt(d.amount)}</span>
            </>
          )}
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: height - 42, cursor: 'crosshair' }} />
    </div>
  )
}

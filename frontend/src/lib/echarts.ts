// ECharts 按需注册 (全站唯一入口): 减小首包体积, 各图表组件统一从这里拿实例
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

export type EChartsInst = echarts.EChartsType
export { echarts }

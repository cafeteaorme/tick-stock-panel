import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QK } from './queryKeys'
import { api } from './api'
import { toast } from '@/components/Toast'

export type TzzbJob = { key: string; label?: string; status: string; ok?: boolean | null; message?: string; started_at?: string; finished_at?: string }

/**
 * 账本后台任务轮询 (页面级常驻, 任务面板关闭时也能感知完成)。
 * 运行中 1.5s / 空闲 8s; 运行→完成沿: 精确失效受影响业务 key + toast。
 * 严禁无参 invalidateQueries — 会清空全站缓存造成请求风暴。
 */
export function useTzzbJobs() {
  const qc = useQueryClient()
  const jobsQ = useQuery({
    queryKey: QK.holdingsTzzbJobs,
    queryFn: api.holdingsTzzbJobs,
    refetchInterval: (q: { state: { data?: { jobs: TzzbJob[] } } }) =>
      (q.state.data?.jobs ?? []).some(j => j.status === 'running') ? 1_500 : 8_000,
  })
  const prevJobStatus = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const j of jobsQ.data?.jobs ?? []) {
      const was = prevJobStatus.current[j.key]
      prevJobStatus.current[j.key] = j.status
      if (was !== 'running' || j.status !== 'done') continue
      qc.invalidateQueries({ queryKey: QK.holdings })
      qc.invalidateQueries({ queryKey: QK.holdingsSummary })
      qc.invalidateQueries({ queryKey: ['holdings-pnl'] })
      qc.invalidateQueries({ queryKey: QK.holdingsAccounts })
      qc.invalidateQueries({ queryKey: QK.holdingsTzzbJobs })
      // 同步成功后链式更新真实成交缓存 (B/S 点 + 清仓核对/月度胜率数据源)
      if (j.key === 'sync' && j.ok) {
        api.holdingsTzzbTradesRefresh()
          .then(() => {
            qc.invalidateQueries({ queryKey: QK.holdingsTzzbClearedCheck() })
            qc.invalidateQueries({ queryKey: QK.holdingsTzzbMonthlyStats })
          })
          .catch(() => {})
      }
      if (j.ok) toast(`${j.label || j.key}完成：${j.message || ''}`, 'success')
      else toast(`${j.label || j.key}失败：${j.message || ''}`, 'error')
    }
  }, [jobsQ.data, qc])
  return jobsQ
}

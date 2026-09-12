import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Settings as SettingsIcon, Sparkles, X } from 'lucide-react'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { toast } from '@/components/Toast'
import { renderMd } from './shared'

export type TzzbJob = { key: string; label?: string; status: string; ok?: boolean | null; message?: string; started_at?: string; finished_at?: string }


export function BgTasksPanel({ jobs, onClose }: { jobs: TzzbJob[]; onClose: () => void }) {
  const qc = useQueryClient()
  const tasks = useQuery({ queryKey: QK.holdingsBgTasks, queryFn: api.holdingsBgTasks, refetchInterval: 30_000 })
  const trades = useQuery({ queryKey: QK.holdingsTzzbTrades, queryFn: api.holdingsTzzbTrades })
  // 任务状态轮询提升到页面级 (Holdings 组件), 面板关闭时也能感知任务完成
  const jobOf = (k: string) => jobs.find(j => j.key === k)
  const running = (k: string) => jobOf(k)?.status === 'running'
  const start = (key: 'trades' | 'history', fn: () => Promise<unknown>) => {
    if (running(key)) return
    Promise.resolve(fn()).catch(() => toast('任务启动失败', 'error'))
    qc.invalidateQueries({ queryKey: QK.holdingsTzzbJobs })
  }
  const JobRow = ({ k, btn }: { k: 'trades' | 'history'; btn: string }) => {
    const j = jobOf(k)
    const isRun = j?.status === 'running'
    return (
      <div className="space-y-1">
        <div className="flex gap-2">
          <button disabled={isRun} onClick={() => start(k, k === 'trades' ? () => api.holdingsTzzbTradesRefresh() : () => api.holdingsTzzbHistoryFetch())}
            className="flex-1 px-2 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground disabled:opacity-40">
            {isRun ? '拉取中…' : btn}
          </button>
        </div>
        {isRun && (
          <div className="h-1 rounded-full bg-elevated overflow-hidden">
            <div className="h-full w-1/3 rounded-full bg-accent/70 animate-[tfjob_1.2s_ease-in-out_infinite_alternate]" />
          </div>
        )}
        {j?.status === 'done' && (
          <div className={`text-[11px] ${j.ok ? 'text-emerald-400' : 'text-danger'}`}>
            {j.ok ? '✓' : '✗'} {j.message}{j.finished_at ? ` · ${j.finished_at.slice(11, 19)}` : ''}
          </div>
        )}
      </div>
    )
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
          <JobRow k="trades" btn="立即拉取真实成交" />
          <JobRow k="history" btn="立即拉取历史收益" />
        </div>
      </div>
    </div>
  )
}


export function AiReportPanel({ onClose }: { onClose: () => void }) {
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

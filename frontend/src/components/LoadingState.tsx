/** 通用加载/错误组件: 各页统一体验 */
import { Loader2, RefreshCw } from 'lucide-react'

export function LoadingSkeleton({ height = 120, rows = 4 }: { height?: number; rows?: number }) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 animate-pulse" style={{ height }}>
      <div className="h-3 w-24 bg-elevated rounded mb-3" />
      <div className="h-7 w-48 bg-elevated rounded mb-4" />
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 w-full bg-elevated rounded" />
        ))}
      </div>
    </div>
  )
}

export function LoadingInline({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="flex items-center justify-center py-10 text-xs text-muted gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      {text}
    </div>
  )
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-card border border-danger/30 bg-danger/5 px-4 py-3 flex items-center gap-3">
      <span className="text-xs text-danger flex-1">{message || '加载失败'}</span>
      {onRetry && (
        <button onClick={onRetry} className="px-3 py-1.5 rounded-btn bg-elevated text-xs text-secondary hover:text-foreground inline-flex items-center gap-1">
          <RefreshCw className="h-3 w-3" />重试
        </button>
      )}
    </div>
  )
}

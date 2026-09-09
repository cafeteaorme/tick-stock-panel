import { useEffect, useState } from 'react'
import { ImageIcon, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'

export interface PickedImage {
  file: File
  date: string     // YYYY-MM-DD (文件修改/拍摄日期)
  key: string      // 去重标识
}

/**
 * 最近截图/照片选择器。
 * layout='strip': 横向滚动小图条 (自选导入用)
 * layout='grid':  竖向滚动网格, 一行 5 个大预览 (持仓导入用)
 */
export function RecentPhotoStrip({
  pickedKeys,
  onPick,
  limit = 24,
  layout = 'strip',
}: {
  pickedKeys: Set<string>
  onPick: (img: PickedImage) => void
  limit?: number
  layout?: 'strip' | 'grid'
}) {
  const [photos, setPhotos] = useState<{ name: string; date: string; url: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .recentPhotos(limit)
      .then(res => { if (!cancelled) setPhotos(res.photos) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [limit])

  const pick = async (p: { name: string; date: string; url: string }) => {
    setPicking(p.url)
    try {
      const res = await fetch(p.url)
      if (!res.ok) throw new Error('读取失败')
      const blob = await res.blob()
      const ms = new Date(p.date).getTime()
      const file = new File([blob], p.name.split('/').pop() || 'photo.jpg', {
        type: blob.type || 'image/jpeg',
        lastModified: Number.isNaN(ms) ? Date.now() : ms,
      })
      onPick({ file, date: p.date, key: p.url })
    } catch {
      /* 静默; 缩略图点击失败不打断 */
    } finally {
      setPicking(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted py-1">
        <Loader2 className="h-3 w-3 animate-spin" />加载最近截图…
      </div>
    )
  }
  if (photos.length === 0) return null

  const thumbCls =
    layout === 'grid'
      ? 'w-full h-28 rounded-btn overflow-hidden border transition-all relative'
      : 'shrink-0 w-16 h-20 rounded-btn overflow-hidden border transition-all relative'

  const body = (
    <div className={layout === 'grid' ? 'grid grid-cols-5 gap-2.5' : 'flex gap-2 overflow-x-auto pb-1'}>
      {photos.map(p => {
        const picked = pickedKeys.has(p.url)
        return (
          <button
            key={p.url}
            type="button"
            disabled={picking === p.url}
            onClick={() => pick(p)}
            className={`${thumbCls}
              ${picked ? 'border-accent ring-1.5 ring-accent' : 'border-border hover:border-accent/50'}`}
            title={`${p.date} ${p.name}`}
          >
            <img src={p.url} alt={p.name} className="w-full h-full object-cover" loading="lazy" />
            <span className={`absolute bottom-0 inset-x-0 bg-black/55 text-white text-center leading-3.5 ${layout === 'grid' ? 'text-[10px] py-0.5' : 'text-[8px]'}`}>
              {p.date.slice(5)}
            </span>
            {picking === p.url && (
              <span className="absolute inset-0 bg-black/40 flex items-center justify-center">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )

  if (layout === 'grid') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs text-secondary">
          <ImageIcon className="h-3.5 w-3.5" />
          最近截图/照片（点击选入，可多选）
        </div>
        <div className="max-h-72 overflow-y-auto pr-1">{body}</div>
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-secondary">
        <ImageIcon className="h-3 w-3" />
        最近截图/照片（点击选入，可多选）
      </div>
      {body}
    </div>
  )
}

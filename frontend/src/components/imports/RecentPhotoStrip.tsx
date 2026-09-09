import { useEffect, useState } from 'react'
import { ImageIcon, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'

export interface PickedImage {
  file: File
  date: string     // YYYY-MM-DD (文件修改/拍摄日期)
  key: string      // 去重标识
}

/**
 * 最近截图/照片横条: 下载/桌面/图片/图库(已授权时) 按时间倒序。
 * 点击缩略图即选入 (可多选, 已选高亮)。
 */
export function RecentPhotoStrip({
  pickedKeys,
  onPick,
  limit = 18,
}: {
  pickedKeys: Set<string>
  onPick: (img: PickedImage) => void
  limit?: number
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

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-secondary">
        <ImageIcon className="h-3 w-3" />
        最近截图/照片（点击选入，可多选）
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {photos.map(p => {
          const picked = pickedKeys.has(p.url)
          return (
            <button
              key={p.url}
              type="button"
              disabled={picking === p.url}
              onClick={() => pick(p)}
              className={`shrink-0 w-16 h-20 rounded-btn overflow-hidden border transition-all relative
                ${picked ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50'}`}
              title={`${p.date} ${p.name}`}
            >
              <img src={p.url} alt={p.name} className="w-full h-full object-cover" loading="lazy" />
              <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[8px] text-center leading-3.5">
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
    </div>
  )
}

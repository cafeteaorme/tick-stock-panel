import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

export function useHeldSymbols() {
  return useQuery({
    queryKey: ['held-symbols'],
    queryFn: api.holdingsHeldSymbols,
    staleTime: 30_000,
  })
}

/** 持仓徽章: 全站股票列表复用。持有返回徽章节点, 否则 null。 */
export function HeldBadge({ symbol }: { symbol: string }) {
  const { data } = useHeldSymbols()
  const held = (data?.symbols ?? []).includes(symbol)
  if (!held) return null
  return (
    <span
      title="我的持仓"
      className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded text-[9px] font-bold leading-none border border-violet-500/30 bg-violet-500/12 text-violet-400"
    >
      持
    </span>
  )
}

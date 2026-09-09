"""统一行情内存缓存 (TTL)。

多模块 (自选/持仓/个股弹窗) 共用同一份实时行情缓存:
- 15s TTL, 到期后首个请求触发刷新 (fetch_fn 由调用方提供)
- 避免同一 symbol 在多个端点间重复请求 TickFlow, 降配额消耗与等待
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

_TTL_S = 15.0

_cache: dict[str, tuple[float, dict[str, dict]]] = {
    "t": 0.0,
    "rows": {},
}
_lock = threading.Lock()


def invalidate() -> None:
    with _lock:
        _cache["t"] = 0.0
        _cache["rows"] = {}


def get_quotes(
    symbols: list[str],
    fetch_fn: Callable[[list[str]], list[dict]],
    *,
    ttl: float = _TTL_S,
) -> dict[str, dict]:
    """取指定 symbol 的行情。缓存命中直接返回; 过期则调用 fetch_fn 刷新后合并返回。

    即使刷新失败, 也返回旧缓存 (数据不闪失), 下次请求再试。
    """
    if not symbols:
        return {}
    now = time.time()
    with _lock:
        fresh = now - _cache["t"] < ttl
        rows = _cache["rows"]
        hit = {s: rows[s] for s in symbols if s in rows}

    if fresh and len(hit) >= len(symbols):
        return hit

    # 缺漏或过期 → 刷新 (锁外调用, 避免持锁等待网络)
    missing = [s for s in symbols if s not in rows] or ([] if fresh else symbols)
    try:
        fetched = fetch_fn(list(dict.fromkeys(missing or symbols)))
    except Exception as e:  # noqa: BLE001
        logger.warning("quote refresh failed (%d syms): %s", len(missing or symbols), e)
        fetched = []

    with _lock:
        if fetched:
            for q in fetched:
                sym = q.get("symbol")
                if sym:
                    rows[sym] = q
        _cache["t"] = now
        return {s: rows[s] for s in symbols if s in rows}

"""港股/美股标的维表同步。

拉取 tf.exchanges.get_instruments("HK"/"US", type="stock") 全量清单,
写入 data/instruments_hk/ 与 data/instruments_us/ 独立 parquet。

- 不并入 A股 instruments 目录 → 选股器/回测 universe 不受影响
- 该清单同时作为截图识别 (OCR/AI) 的港美股代码字典
- watchlist 名称解析 / 标的搜索会读取这两张表
"""
from __future__ import annotations

import logging
import threading
from datetime import date
from pathlib import Path

import polars as pl

from app.tickflow.client import get_client

logger = logging.getLogger(__name__)

_HK_US_EXCHANGES = ("HK", "US")

_sync_lock = threading.Lock()
_syncing = False


def _dir_for(exchange: str, data_dir: Path) -> Path:
    return data_dir / f"instruments_{exchange.lower()}"


def sync_hk_us_instruments(data_dir: Path, exchanges: tuple[str, ...] = _HK_US_EXCHANGES) -> dict[str, int]:
    """同步港美股标的维表。返回 {exchange: 行数}。"""
    global _syncing
    with _sync_lock:
        if _syncing:
            logger.info("hk/us instruments sync already running, skip")
            return {}
        _syncing = True
    try:
        tf = get_client()
        counts: dict[str, int] = {}
        for ex in exchanges:
            try:
                items = tf.exchanges.get_instruments(ex, instrument_type="stock")
            except Exception as e:  # noqa: BLE001
                logger.warning("get_instruments(%s) failed: %s", ex, e)
                continue
            rows = []
            for it in items or []:
                if not isinstance(it, dict) or not it.get("symbol"):
                    continue
                ext = it.get("ext") or {}
                rows.append({
                    "symbol": it.get("symbol"),
                    "name": it.get("name"),
                    "code": it.get("code"),
                    "exchange": it.get("exchange"),
                    "region": it.get("region") or ex,
                    "type": it.get("type") or "stock",
                    "total_shares": ext.get("total_shares"),
                    "float_shares": ext.get("float_shares"),
                })
            if not rows:
                continue
            df = pl.DataFrame(rows).with_columns(pl.lit(date.today()).alias("as_of"))
            out_dir = _dir_for(ex, data_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            df.write_parquet(out_dir / "instruments.parquet")
            counts[ex] = df.height
            logger.info("instruments %s synced: %d rows", ex, df.height)
        return counts
    finally:
        _syncing = False


def sync_hk_us_instruments_background(data_dir: Path) -> bool:
    """后台线程同步 (首次搜索未命中本地港美股表时触发)。已在线程池则返回 False。"""
    if _syncing:
        return False
    t = threading.Thread(target=sync_hk_us_instruments, args=(data_dir,), daemon=True)
    t.start()
    return True


def load_hk_us_instruments(data_dir: Path) -> pl.DataFrame:
    """读取本地港美股标的表 (可能为空)。"""
    parts: list[pl.DataFrame] = []
    for ex in _HK_US_EXCHANGES:
        path = _dir_for(ex, data_dir) / "instruments.parquet"
        if path.exists():
            try:
                parts.append(pl.read_parquet(path))
            except Exception as e:  # noqa: BLE001
                logger.warning("read %s failed: %s", path, e)
    if not parts:
        return pl.DataFrame()
    return pl.concat(parts, how="diagonal_relaxed")

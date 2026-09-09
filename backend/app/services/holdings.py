"""我的持仓服务。

存储:
- `data/user_data/holdings.parquet`: symbol, qty, available, avg_cost, opened_at, status(open/closed), closed_at, realized_pnl
- `data/user_data/portfolio.json`: {initial_cap, cash, updated_at} — 初始资金 + 当前现金 (手动维护)

全量读写小文件 (与 watchlist 同模式); 卖出记录已实现盈亏, status=closed 后自选/详情不再显示持仓徽章。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

import polars as pl

from app.config import settings

logger = logging.getLogger(__name__)

_SCHEMA = {
    "symbol": pl.Utf8,
    "qty": pl.Float64,
    "available": pl.Float64,
    "avg_cost": pl.Float64,
    "opened_at": pl.Utf8,
    "status": pl.Utf8,
    "closed_at": pl.Utf8,
    "realized_pnl": pl.Float64,
}


def _path() -> Path:
    p = settings.data_dir / "user_data" / "holdings.parquet"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _portfolio_path() -> Path:
    return settings.data_dir / "user_data" / "portfolio.json"


def _read() -> pl.DataFrame:
    p = _path()
    if not p.exists():
        return pl.DataFrame(schema=_SCHEMA)
    df = pl.read_parquet(p)
    for col, dtype in _SCHEMA.items():
        if col not in df.columns:
            df = df.with_columns(pl.lit(None, dtype=dtype).alias(col))
    return df


def _write(df: pl.DataFrame) -> None:
    df.write_parquet(_path())


def list_all(include_closed: bool = False) -> list[dict[str, Any]]:
    df = _read()
    if df.is_empty():
        return []
    if not include_closed:
        df = df.filter(pl.col("status") != "closed")
    return df.sort("symbol").to_dicts()


def get(symbol: str) -> dict[str, Any] | None:
    df = _read()
    hit = df.filter((pl.col("symbol") == symbol) & (pl.col("status") != "closed"))
    return hit.to_dicts()[0] if not hit.is_empty() else None


def upsert(
    symbol: str,
    qty: float,
    available: float | None = None,
    avg_cost: float | None = None,
) -> list[dict]:
    """新增或编辑持仓 (数量/可用/成本)。已 closed 的同名持仓按新增处理。"""
    df = _read()
    df = df.filter(~((pl.col("symbol") == symbol) & (pl.col("status") != "closed")))
    row = {
        "symbol": symbol,
        "qty": float(qty),
        "available": float(available if available is not None else qty),
        "avg_cost": float(avg_cost) if avg_cost is not None else None,
        "opened_at": datetime.utcnow().isoformat(timespec="seconds"),
        "status": "open",
        "closed_at": None,
        "realized_pnl": None,
    }
    out = pl.concat([pl.DataFrame([row], schema=_SCHEMA), df], how="diagonal_relaxed")
    _write(out)
    return list_all()


def sell(symbol: str, price: float, qty: float | None = None) -> dict[str, Any]:
    """卖出: 记录已实现盈亏后置 closed。qty 缺省为全部持仓。

    realized_pnl = (卖出价 - 成本) × 卖出数量; 部分卖出时剩余数量与成本不变。
    """
    h = get(symbol)
    if h is None:
        raise ValueError(f"{symbol} 不在持仓中")
    cost = h.get("avg_cost") or 0.0
    sell_qty = float(qty) if qty is not None else float(h["qty"])
    sell_qty = min(sell_qty, float(h["qty"]))
    realized = (float(price) - float(cost)) * sell_qty

    df = _read()
    if sell_qty >= float(h["qty"]) - 1e-9:
        # 全部卖出 → closed, 保留记录 (realized 累加)
        prev = h.get("realized_pnl") or 0.0
        df = df.filter((pl.col("symbol") != symbol) | (pl.col("status") != "open"))
        row = {
            "symbol": symbol,
            "qty": 0.0,
            "available": 0.0,
            "avg_cost": cost,
            "opened_at": h.get("opened_at"),
            "status": "closed",
            "closed_at": datetime.utcnow().isoformat(timespec="seconds"),
            "realized_pnl": (float(h["realized_pnl"]) if h.get("realized_pnl") else 0.0) + realized,
        }
        df = pl.concat([pl.DataFrame([row], schema=_SCHEMA), df], how="diagonal_relaxed")
    else:
        remain = float(h["qty"]) - sell_qty
        df = df.with_columns(
            pl.when((pl.col("symbol") == symbol) & (pl.col("status") != "closed"))
            .then(
                pl.min_horizontal(pl.col("available") - sell_qty, pl.lit(remain)).clip(lower_bound=0.0)
            )
            .otherwise(pl.col("available"))
            .alias("available")
        ).with_columns(
            pl.when((pl.col("symbol") == symbol) & (pl.col("status") != "closed"))
            .then(remain)
            .otherwise(pl.col("qty"))
            .alias("qty")
        ).with_columns(
            pl.when((pl.col("symbol") == symbol) & (pl.col("status") != "closed"))
            .then(pl.col("realized_pnl").fill_null(0.0) + realized)
            .otherwise(pl.col("realized_pnl"))
            .alias("realized_pnl")
        )
    _write(df)
    return {"symbol": symbol, "realized_pnl": realized}


def remove(symbol: str) -> list[dict]:
    """彻底删除持仓记录 (含 closed)。"""
    df = _read().filter(pl.col("symbol") != symbol)
    _write(df)
    return list_all(include_closed=True)


def clear() -> int:
    df = _read()
    n = df.height
    if n:
        pl.DataFrame(schema=_SCHEMA).write_parquet(_path())
    return n


# ---------------------------------------------------------------- 组合资金


def get_portfolio() -> dict[str, Any]:
    p = _portfolio_path()
    try:
        obj = json.loads(p.read_text("utf-8"))
        return {
            "initial_cap": float(obj.get("initial_cap") or 0.0),
            "cash": float(obj.get("cash") or 0.0),
            "updated_at": obj.get("updated_at"),
        }
    except Exception:  # noqa: BLE001
        return {"initial_cap": 0.0, "cash": 0.0, "updated_at": None}


def set_portfolio(initial_cap: float | None = None, cash: float | None = None) -> dict[str, Any]:
    cur = get_portfolio()
    obj = {
        "initial_cap": float(initial_cap) if initial_cap is not None else cur["initial_cap"],
        "cash": float(cash) if cash is not None else cur["cash"],
        "updated_at": datetime.utcnow().isoformat(timespec="seconds"),
    }
    _portfolio_path().write_text(json.dumps(obj, ensure_ascii=False), "utf-8")
    return obj

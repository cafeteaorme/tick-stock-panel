"""我的持仓 API。"""
from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from typing import Any

import polars as pl
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.services import holdings as holdings_service
from app.markets import HK, US, get_region, is_hk_or_us
from app.services import watchlist as watchlist_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/holdings", tags=["holdings"])


class UpsertRequest(BaseModel):
    qty: float
    available: float | None = None
    avg_cost: float | None = None


class SellRequest(BaseModel):
    price: float
    qty: float | None = None


class PortfolioRequest(BaseModel):
    initial_cap: float | None = None
    cash: float | None = None


class BatchImportRequest(BaseModel):
    """截图导入: [{symbol, qty, available?, cost?}]"""
    items: list[dict]


def _fetch_quotes_map(request: Request, symbols: list[str]) -> dict[str, dict]:
    """symbol → 实时行情 (TickFlow quotes, A股/港美股通用)。失败返回空。"""
    if not symbols:
        return {}
    capset = getattr(request.app.state, "capabilities", None)
    if capset is None:
        return {}
    try:
        rows = watchlist_service.fetch_quotes(symbols, capset)
    except Exception as e:  # noqa: BLE001
        logger.warning("holdings quotes failed: %s", e)
        return {}
    out = {}
    for r in rows or []:
        sym = r.get("symbol")
        if not sym:
            continue
        out[sym] = r
    return out


def _enrich_rows(request: Request, rows: list[dict]) -> list[dict]:
    """给持仓行附加现价/涨跌幅/市值/浮动盈亏/当日盈亏。"""
    symbols = [r["symbol"] for r in rows]
    repo = request.app.state.repo
    quotes = _fetch_quotes_map(request, symbols)
    name_map = repo.get_name_map(symbols)

    out = []
    for r in rows:
        q = quotes.get(r["symbol"]) or {}
        price = q.get("price") or q.get("last_price")
        pct = q.get("pct")
        qty = float(r.get("qty") or 0)
        cost = float(r.get("avg_cost") or 0)
        market_value = price * qty if price is not None else None
        float_pnl = (price - cost) * qty if price is not None and cost else None
        day_pnl = float_pnl / (1 + pct) * pct if (float_pnl is not None and pct not in (None, -1)) else None
        # 更稳的当日盈亏: 市值 - 市值/(1+pct)
        if price is not None and pct is not None and (1 + pct) != 0:
            day_pnl = market_value - market_value / (1 + pct)
        out.append({
            **r,
            "name": name_map.get(r["symbol"]),
            "region": get_region(r["symbol"]),
            "price": price,
            "change_pct": pct,
            "change_amount": q.get("ext.change_amount"),
            "market_value": market_value,
            "float_pnl": float_pnl,
            "float_pnl_pct": ((price - cost) / cost) if (price is not None and cost) else None,
            "day_pnl": day_pnl,
        })
    return out


@router.get("")
def list_holdings(request: Request, include_closed: bool = Query(False)):
    """持仓列表 (含实时行情与盈亏)。closed 记录仅在 include_closed 时返回。"""
    rows = holdings_service.list_all(include_closed=include_closed)
    open_rows = [r for r in rows if r.get("status") != "closed"]
    enriched = _enrich_rows(request, open_rows)
    if include_closed:
        enriched = enriched + [r for r in rows if r.get("status") == "closed"]
    return {"rows": enriched}


@router.get("/summary")
def summary(request: Request):
    """组合汇总: 总资产/仓位/总盈亏(浮动+已实现)/当日盈亏/个股贡献。"""
    rows = holdings_service.list_all()
    enriched = _enrich_rows(request, rows)
    portfolio = holdings_service.get_portfolio()

    total_value = sum(r["market_value"] or 0 for r in enriched)
    total_asset = portfolio["cash"] + total_value
    float_pnl = sum(r["float_pnl"] or 0 for r in enriched)
    closed_rows = holdings_service.list_all(include_closed=True)
    realized = sum(float(r.get("realized_pnl") or 0) for r in closed_rows if r.get("status") == "closed")
    day_pnl = sum(r["day_pnl"] or 0 for r in enriched)
    initial = portfolio["initial_cap"]

    contributions = sorted(
        ({"symbol": r["symbol"], "name": r["name"], "float_pnl": r["float_pnl"], "market_value": r["market_value"]} for r in enriched),
        key=lambda x: x["float_pnl"] or 0,
        reverse=True,
    )
    return {
        "initial_cap": initial,
        "cash": portfolio["cash"],
        "total_market_value": total_value,
        "total_asset": total_asset,
        "position_pct": (total_value / total_asset) if total_asset else None,
        "float_pnl": float_pnl,
        "realized_pnl": realized,
        "total_pnl": float_pnl + realized,
        "total_pnl_pct": ((float_pnl + realized) / initial) if initial else None,
        "day_pnl": day_pnl,
        "day_pnl_pct": (day_pnl / (total_asset - day_pnl)) if (total_asset - day_pnl) else None,
        "positions": len(enriched),
        "contributions": contributions,
        "updated_at": portfolio.get("updated_at"),
    }


@router.put("/portfolio")
def update_portfolio(req: PortfolioRequest):
    return holdings_service.set_portfolio(req.initial_cap, req.cash)


@router.put("/{symbol}")
def upsert_holding(symbol: str, req: UpsertRequest):
    if req.qty <= 0:
        raise HTTPException(400, "数量必须大于 0")
    rows = holdings_service.upsert(symbol, req.qty, req.available, req.avg_cost)
    return {"rows": rows}


@router.post("/{symbol}/sell")
def sell_holding(symbol: str, req: SellRequest):
    try:
        res = holdings_service.sell(symbol, req.price, req.qty)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return res


@router.delete("/{symbol}")
def remove_holding(symbol: str):
    return {"rows": holdings_service.remove(symbol)}


@router.post("/import")
def batch_import(req: BatchImportRequest, request: Request):
    """截图识别结果批量写入持仓 (并自动加入自选)。"""
    from app.services import watchlist as wl

    for item in req.items:
        sym = str(item.get("symbol") or "").strip()
        if not sym:
            continue
        qty = float(item.get("qty") or 0)
        if qty <= 0:
            continue
        holdings_service.upsert(
            sym, qty,
            available=float(item.get("available")) if item.get("available") is not None else qty,
            avg_cost=float(item["cost"]) if item.get("cost") else None,
        )
        # 持仓自动进自选
        existing = {r["symbol"] for r in wl.list_symbols()}
        if sym not in existing:
            wl.add(sym)
    return {"imported": len(req.items)}


# ---------------------------------------------------------------- 收益序列


def _load_close_history(request: Request, symbols: list[str], start: date, end: date) -> dict[str, dict[str, float]]:
    """{symbol: {date_iso: close}} — A股走本地 enriched batch, 港美股单只拉取。"""
    repo = request.app.state.repo
    series: dict[str, dict[str, float]] = {}

    cn = [s for s in symbols if not is_hk_or_us(s)]
    hk_us = [s for s in symbols if is_hk_or_us(s)]

    if cn:
        try:
            df = repo.get_daily_batch(cn, start, end, columns=["symbol", "date", "close"])
            for sym, d, c in df.select(["symbol", "date", "close"]).iter_rows():
                series.setdefault(sym, {})[str(d)] = float(c)
        except Exception as e:  # noqa: BLE001
            logger.warning("holdings pnl daily batch failed: %s", e)

    for sym in hk_us:
        try:
            from app.services.kline_sync import fetch_hk_us_daily_with_indicators

            df = fetch_hk_us_daily_with_indicators(sym, days=max((end - start).days + 10, 30))
            if not df.is_empty() and "date" in df.columns:
                sub = df.filter((pl.col("date") >= start) & (pl.col("date") <= end))
                for d, c in sub.select(["date", "close"]).iter_rows():
                    series.setdefault(sym, {})[str(d)] = float(c)
        except Exception as e:  # noqa: BLE001
            logger.warning("holdings pnl hk/us %s failed: %s", sym, e)
    return series


@router.get("/pnl")
def pnl(
    request: Request,
    start: str | None = Query(None, description="YYYY-MM-DD, 默认今年初"),
    end: str | None = Query(None, description="YYYY-MM-DD, 默认今天"),
):
    """日/月/年收益序列 (快照 + 日K回算: 假设区间内持仓不变)。

    daily: [{date, market_value, asset, pnl, pnl_pct}] — asset = 现金 + Σ close×qty
    monthly/yearly: 对应区间的 pnl 汇总。
    """
    from datetime import datetime as _dt

    end_d = date.fromisoformat(end) if end else date.today()
    start_d = date.fromisoformat(start) if start else date(end_d.year, 1, 1)

    rows = holdings_service.list_all()
    portfolio = holdings_service.get_portfolio()
    cash = portfolio["cash"]
    qty_map = {r["symbol"]: float(r.get("qty") or 0) for r in rows}

    series = _load_close_history(request, list(qty_map), start_d - timedelta(days=14), end_d) if qty_map else {}

    # 交易日并集 + 前向填充
    all_dates = sorted({d for m in series.values() for d in m})
    all_dates = [d for d in all_dates if start_d.isoformat() <= d <= end_d.isoformat()]
    if not all_dates:
        return {"daily": [], "monthly": [], "yearly": [], "cash": cash}

    last_close: dict[str, float] = {}
    daily: list[dict] = []
    prev_asset: float | None = None
    for d in all_dates:
        value = cash
        for sym, q in qty_map.items():
            c = series.get(sym, {}).get(d)
            if c is not None:
                last_close[sym] = c
            value += last_close.get(sym, 0.0) * q
        pnl = (value - prev_asset) if prev_asset is not None else 0.0
        daily.append({
            "date": d,
            "market_value": round(value - cash, 2),
            "asset": round(value, 2),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl / prev_asset, 6) if prev_asset else None,
        })
        prev_asset = value

    # 今日实时覆盖: 用实时行情修正最后一个交易日的 asset/pnl
    quotes = _fetch_quotes_map(request, list(qty_map))
    if quotes:
        rt_value = cash + sum(
            (quotes[s].get("price") or last_close.get(s, 0.0)) * q for s, q in qty_map.items()
        )
        if daily:
            prev = daily[-2]["asset"] if len(daily) >= 2 else None
            daily[-1]["market_value"] = round(rt_value - cash, 2)
            daily[-1]["asset"] = round(rt_value, 2)
            if prev is not None:
                daily[-1]["pnl"] = round(rt_value - prev, 2)
                daily[-1]["pnl_pct"] = round((rt_value - prev) / prev, 6)

    def _agg(key_len: int) -> list[dict]:
        buckets: dict[str, dict] = {}
        for r in daily:
            k = r["date"][:key_len]
            b = buckets.setdefault(k, {"period": k, "pnl": 0.0, "days": 0, "pnl_pct": None})
            b["pnl"] += r["pnl"] or 0
            b["days"] += 1
        out = []
        for k in sorted(buckets):
            b = buckets[k]
            out.append({"period": k, "pnl": round(b["pnl"], 2), "days": b["days"]})
        return out

    return {
        "daily": daily,
        "monthly": _agg(7),
        "yearly": _agg(4),
        "cash": cash,
        "initial_cap": portfolio["initial_cap"],
    }


@router.get("/benchmark")
def benchmark(
    request: Request,
    symbol: str = Query("000001.SH", description="基准指数, 默认上证指数"),
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    """同期基准指数收盘序列 (供收益曲线叠加)。"""
    repo = request.app.state.repo
    end_d = date.fromisoformat(end) if end else date.today()
    start_d = date.fromisoformat(start) if start else date(end_d.year, 1, 1)
    try:
        df = repo.get_index_daily(symbol, start_d, end_d)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"基准指数读取失败: {e}") from e
    if df.is_empty() or "close" not in df.columns:
        return {"symbol": symbol, "dates": [], "closes": []}
    return {
        "symbol": symbol,
        "name": (repo.get_name_map([symbol]).get(symbol)),
        "dates": [str(d) for d in df["date"].to_list()],
        "closes": df["close"].to_list(),
    }

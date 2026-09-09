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
    """截图导入: [{symbol, qty, available?, cost?}]; date 非今日 → 存历史快照"""
    items: list[dict]
    date: str | None = None
    cash: float | None = None


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
    """截图识别结果批量写入持仓 (并自动加入自选)。

    date 为今日或缺省 → 更新当前持仓; 历史日期 → 写入该日快照 (含当日现金)。
    """
    from app.services import watchlist as wl

    today = date.today().isoformat()
    target = (req.date or today) if (req.date or today) <= today else today
    normalized = []
    for item in req.items:
        sym = str(item.get("symbol") or "").strip()
        qty = float(item.get("qty") or 0)
        if not sym or qty <= 0:
            continue
        normalized.append({
            "symbol": sym,
            "qty": qty,
            "available": float(item.get("available")) if item.get("available") is not None else qty,
            "avg_cost": float(item["cost"]) if item.get("cost") else None,
        })

    if target == today:
        for item in normalized:
            holdings_service.upsert(
                item["symbol"], item["qty"], item["available"], item["avg_cost"],
            )
            if item["symbol"] not in {r["symbol"] for r in wl.list_symbols()}:
                wl.add(item["symbol"])
    else:
        # 历史日期: 写快照 (金额以截图当时为准)
        holdings_service.save_snapshot(target, rows=normalized, cash=req.cash)

    return {"imported": len(normalized), "date": target, "snapshot": target != today}


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
    """日/月/年收益序列 (快照时间线分段回算: 各段各自的数量/现金)。

    daily: [{date, market_value, asset, pnl, pnl_pct}] — asset = 段内现金 + Σ close×qty
    monthly/yearly: 对应区间的 pnl 汇总。
    """
    end_d = date.fromisoformat(end) if end else date.today()
    start_d = date.fromisoformat(start) if start else date(end_d.year, 1, 1)

    timeline = holdings_service.snapshot_timeline()
    if not timeline:
        return {"daily": [], "monthly": [], "yearly": [], "cash": holdings_service.get_portfolio()["cash"]}

    # 无历史快照 (仅今日当前持仓一段) → 回退为当前持仓回算整个区间 (v1 行为);
    # 有历史快照 → 从最早快照日期开始分段
    has_snapshot = len(timeline) > 1 or timeline[0]["date"] < date.today().isoformat()
    first_seg_date = timeline[0]["date"] if has_snapshot else start_d.isoformat()
    eff_start = max(start_d.isoformat(), first_seg_date)
    if not has_snapshot:
        timeline = [{
            "date": eff_start,
            "cash": timeline[0]["cash"],
            "rows": timeline[0]["rows"],
        }, timeline[0]] if timeline[0]["date"] != eff_start else timeline

    all_symbols = sorted({r["symbol"] for seg in timeline for r in seg["rows"] if r.get("qty")})
    series = _load_close_history(request, all_symbols, date.fromisoformat(eff_start) - timedelta(days=14), end_d) if all_symbols else {}

    all_dates = sorted({d for m in series.values() for d in m})
    all_dates = [d for d in all_dates if eff_start <= d <= end_d.isoformat()]
    if not all_dates:
        return {"daily": [], "monthly": [], "yearly": [], "cash": timeline[-1]["cash"]}

    def _seg_for(d: str) -> dict:
        cur = timeline[0]
        for seg in timeline:
            if seg["date"] <= d:
                cur = seg
            else:
                break
        return cur

    last_close: dict[str, float] = {}
    daily: list[dict] = []
    prev_asset: float | None = None
    for d in all_dates:
        seg = _seg_for(d)
        cash = seg["cash"]
        value = cash
        for r in seg["rows"]:
            sym, q = r["symbol"], float(r.get("qty") or 0)
            if not q:
                continue
            c = series.get(sym, {}).get(d)
            if c is not None:
                last_close[sym] = c
            value += last_close.get(sym, 0.0) * q
        day_pnl = (value - prev_asset) if prev_asset is not None else 0.0
        daily.append({
            "date": d,
            "market_value": round(value - cash, 2),
            "asset": round(value, 2),
            "pnl": round(day_pnl, 2),
            "pnl_pct": round(day_pnl / prev_asset, 6) if prev_asset else None,
        })
        prev_asset = value

    # 今日实时覆盖
    today_iso = end_d.isoformat()
    if daily and daily[-1]["date"] == today_iso:
        cur_seg = timeline[-1]
        quotes = _fetch_quotes_map(request, [r["symbol"] for r in cur_seg["rows"] if r.get("qty")])
        if quotes:
            rt_value = cur_seg["cash"] + sum(
                (quotes[r["symbol"]].get("price") or last_close.get(r["symbol"], 0.0)) * float(r["qty"])
                for r in cur_seg["rows"] if r.get("qty")
            )
            prev = daily[-2]["asset"] if len(daily) >= 2 else None
            daily[-1]["market_value"] = round(rt_value - cur_seg["cash"], 2)
            daily[-1]["asset"] = round(rt_value, 2)
            if prev is not None:
                daily[-1]["pnl"] = round(rt_value - prev, 2)
                daily[-1]["pnl_pct"] = round((rt_value - prev) / prev, 6)

    def _agg(key_len: int) -> list[dict]:
        buckets: dict[str, dict] = {}
        for r in daily:
            k = r["date"][:key_len]
            b = buckets.setdefault(k, {"period": k, "pnl": 0.0, "days": 0})
            b["pnl"] += r["pnl"] or 0
            b["days"] += 1
        return [{"period": k, "pnl": round(buckets[k]["pnl"], 2), "days": buckets[k]["days"]} for k in sorted(buckets)]

    return {
        "daily": daily,
        "monthly": _agg(7),
        "yearly": _agg(4),
        "cash": timeline[-1]["cash"],
        "initial_cap": holdings_service.get_portfolio()["initial_cap"],
        "snapshots": [seg["date"] for seg in timeline],
    }


@router.get("/pnl/day/{day}")
def pnl_day_detail(request: Request, day: str):
    """某日各持仓的盈亏明细 (收益日历点击弹窗用)。"""
    timeline = holdings_service.snapshot_timeline()
    if not timeline:
        return {"date": day, "rows": [], "total": 0}

    seg = timeline[0]
    for s in timeline:
        if s["date"] <= day:
            seg = s
        else:
            break

    rows = [r for r in seg["rows"] if r.get("qty")]
    symbols = [r["symbol"] for r in rows]
    series = _load_close_history(
        request, symbols,
        date.fromisoformat(day) - timedelta(days=14), date.fromisoformat(day) + timedelta(days=1),
    ) if symbols else {}

    repo = request.app.state.repo
    name_map = repo.get_name_map(symbols)
    out = []
    total = 0.0
    for r in rows:
        sym = r["symbol"]
        q = float(r["qty"] or 0)
        closes = series.get(sym, {})
        sorted_dates = sorted(closes)
        d_idx = max((i for i, d in enumerate(sorted_dates) if d <= day), default=None)
        if d_idx is None or d_idx < 0:
            continue
        c_today = closes[sorted_dates[d_idx]]
        c_prev = closes[sorted_dates[d_idx - 1]] if d_idx > 0 else None
        pnl = (c_today - c_prev) * q if c_prev is not None else 0.0
        total += pnl
        out.append({
            "symbol": sym,
            "name": name_map.get(sym),
            "qty": q,
            "close": c_today,
            "pnl": round(pnl, 2),
            "pnl_pct": round((c_today - c_prev) / c_prev, 6) if c_prev else None,
        })
    out.sort(key=lambda x: x["pnl"], reverse=True)
    return {"date": day, "rows": out, "total": round(total, 2)}


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


# ---------------------------------------------------------------- AI 组合体检


_ANALYZE_SYSTEM_PROMPT = """你是一位专业的个人投资组合顾问,擅长从仓位结构、市场分布、盈亏贡献与风险暴露角度对散户持仓做客观「组合体检」。
要求:
1. 只基于提供的数据, 不编造; 数据缺失时明确说明
2. 客观中立, 指出风险与优点, 不构成买卖建议的合规提示放结尾一句
3. 用 markdown 输出, 结构: ## 组合概览 / ## 仓位与集中度 / ## 盈亏与贡献 / ## 风险暴露 / ## 可关注的方向
4. 金额用万/亿缩写, 百分比保留 1 位小数"""


@router.post("/analyze")
async def analyze_holdings(request: Request):
    """AI 组合体检报告 (SSE 流式, 同个股分析协议: meta/delta/done)。"""
    import json as _json

    repo = request.app.state.repo
    summary_data = summary(request)
    rows = holdings_service.list_all()
    enriched = _enrich_rows(request, rows)

    # 近 30 日各持仓涨跌幅概览 (风险判断用)
    risk_brief = []
    for r in enriched:
        try:
            df = repo.get_daily_batch(
                [r["symbol"]], date.today() - timedelta(days=45), date.today(), columns=["date", "close", "change_pct"],
            ) if not is_hk_or_us(r["symbol"]) else None
            if df is not None and not df.is_empty():
                tail = df.tail(30)
                chg = (float(tail["close"][-1]) / float(tail["close"][0]) - 1) if float(tail["close"][0]) else 0
                max_dd = 0.0
                peak = float(tail["close"][0])
                for c in tail["close"].to_list():
                    peak = max(peak, float(c))
                    max_dd = min(max_dd, float(c) / peak - 1)
                risk_brief.append({
                    "symbol": r["symbol"], "name": r.get("name"), "qty": r.get("qty"),
                    "cost": r.get("avg_cost"), "price": r.get("price"),
                    "market_value": r.get("market_value"), "float_pnl": r.get("float_pnl"),
                    "chg_30d": round(chg, 4), "max_drawdown_30d": round(max_dd, 4),
                })
            else:
                risk_brief.append({k: r.get(k) for k in ("symbol", "qty", "avg_cost", "price", "market_value", "float_pnl")})
        except Exception:  # noqa: BLE001
            risk_brief.append({k: r.get(k) for k in ("symbol", "qty", "avg_cost", "price", "market_value", "float_pnl")})

    user_prompt = (
        f"组合汇总: 初始本金 {summary_data['initial_cap']}, 现金 {round(summary_data['cash'],2)}, "
        f"总资产 {round(summary_data['total_asset'],2)}, 仓位 {round((summary_data['position_pct'] or 0)*100,1)}%, "
        f"浮动盈亏 {round(summary_data['float_pnl'],2)}, 已实现盈亏 {round(summary_data['realized_pnl'],2)}, "
        f"当日盈亏 {round(summary_data['day_pnl'],2)}, 持仓数 {summary_data['positions']}\n"
        f"持仓明细 (JSON): {_json.dumps(risk_brief, ensure_ascii=False, default=str)}\n"
        f"请输出组合体检报告。"
    )

    async def stream_gen():
        import re as _re

        from app.services.ai_provider import stream_ai_text

        yield _json.dumps({
            "type": "meta",
            "summary": f"总资产 {round(summary_data['total_asset'],2)} · 仓位 {round((summary_data['position_pct'] or 0)*100,1)}% · 持仓 {summary_data['positions']} 只",
        }, ensure_ascii=False) + "\n"
        # 剥离 reasoning 模型的 <think> 推理段: 命中未闭合前 hold 住输出
        buf = ""
        think_open = False
        try:
            async for delta in stream_ai_text(
                [
                    {"role": "system", "content": _ANALYZE_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.5,
                max_tokens=4000,
            ):
                buf += delta
                if think_open:
                    if "</think>" in buf:
                        buf = buf.split("</think>", 1)[1]
                        think_open = False
                    else:
                        # 仍在思考段; 保留可能被截断的闭合标签前缀
                        keep = buf[-8:]
                        buf = ""
                        if "</think" .startswith(keep.strip()) and keep.strip():
                            buf = keep
                        continue
                elif buf.lstrip().startswith("<think"):
                    think_open = True
                    rest = buf.split("</think>", 1)
                    if len(rest) == 2:
                        buf = rest[1]
                        think_open = False
                    else:
                        buf = ""
                        continue
                if buf:
                    yield _json.dumps({"type": "delta", "content": buf}, ensure_ascii=False) + "\n"
                    buf = ""
            if buf and not think_open:
                yield _json.dumps({"type": "delta", "content": buf}, ensure_ascii=False) + "\n"
            yield _json.dumps({"type": "done"}, ensure_ascii=False) + "\n"
        except Exception as e:  # noqa: BLE001
            yield _json.dumps({"type": "error", "message": f"AI 分析失败: {e}"}, ensure_ascii=False) + "\n"

    from fastapi.responses import StreamingResponse

    return StreamingResponse(
        stream_gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

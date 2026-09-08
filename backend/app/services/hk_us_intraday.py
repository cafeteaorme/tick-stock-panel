"""港美股当日分时 (免费腾讯行情接口)。

数据源: https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=hk00700 / usAAPL.OQ
- 免费、无需 key、https；返回当日 1 分钟线 (时间 价格 累计量 累计额)
- 港股代码 hk+5位数字；美股 us+代码+交易所后缀 (.OQ 纳斯达克 / .N 纽交所 / .A 美交所)，
  无交易所信息时按 .OQ → .N → .A 顺序探测并缓存命中结果

行为:
- 用户查看某只港美股分时 → 记入「当日已看清单」(data/user_data/hk_us_intraday_viewed.json)
- 当日已看的标的, 在其市场开市时段内每 60s 后台自动刷新当日分时并落盘
  (data/kline_minute_hk_us/{YYYYMMDD}.parquet, 每日一文件)
- 收盘后不再请求；清单跨交易日自动重置
"""
from __future__ import annotations

import ipaddress
import json
import logging
import socket
import threading
import urllib.request
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import polars as pl

from app.markets import HK, US, get_region
from app.market_time import HK_TZ, US_EASTERN_TZ, market_open_now

logger = logging.getLogger(__name__)

_TENCENT_URL = "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}"
# SSRF 防护: 仅允许该 https 域名, 解析后 IP 不得为内网/环回/链路本地
_ALLOWED_HOST = "web.ifzq.gtimg.cn"
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": "https://gu.qq.com/",
}
_FETCH_TIMEOUT = 10
_REFRESH_INTERVAL_S = 60
_US_SUFFIXES = (".OQ", ".N", ".A")

# 美股代码 → 交易所后缀 memo (进程内; 未命中时按序探测)
_us_suffix_cache: dict[str, str] = {}

_viewed_lock = threading.Lock()
_refresh_thread: threading.Thread | None = None
_refresh_stop = threading.Event()


# ---------------------------------------------------------------- 安全请求


def _assert_safe_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise ValueError("仅允许 https 请求")
    if (parts.hostname or "").lower() != _ALLOWED_HOST:
        raise ValueError(f"不允许的请求目标: {parts.hostname}")
    # DNS 解析并阻断私网/环回/链路本地 (防 DNS rebinding: 校验解析结果而非域名)
    for info in socket.getaddrinfo(parts.hostname, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("请求目标解析到内网/保留地址")


def _http_get_json(url: str) -> dict[str, Any] | None:
    try:
        _assert_safe_url(url)
        req = urllib.request.Request(url, headers=_HEADERS)
        # 禁止跟随重定向 (重定向可能指向内网)
        opener = urllib.request.build_opener(_NoRedirect)
        with opener.open(req, timeout=_FETCH_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        logger.warning("tencent minute fetch failed %s: %s", url.split("code=")[-1], e)
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


# ---------------------------------------------------------------- 数据源


def _tencent_code(symbol: str) -> str:
    region = get_region(symbol)
    code = symbol.split(".", 1)[0]
    if region == HK:
        return f"hk{code.zfill(5)}"
    suffix = _us_suffix_cache.get(symbol)
    if suffix:
        return f"us{code}{suffix}"
    return f"us{code}{_US_SUFFIXES[0]}"


def _parse_tencent_minutes(payload: dict[str, Any], tcode: str) -> tuple[str, pl.DataFrame]:
    """解析腾讯分时 → (会话日期 YYYY-MM-DD, 分钟 DataFrame)。无有效数据返回空 df。"""
    node = ((payload.get("data") or {}).get(tcode) or {}).get("data") or {}
    session_date = str(node.get("date") or "")
    lines = node.get("data") or []
    if not lines or not session_date or len(session_date) != 8:
        return "", pl.DataFrame()
    rows = []
    prev_vol = 0.0
    prev_amt = 0.0
    d = f"{session_date[:4]}-{session_date[4:6]}-{session_date[6:]}"
    for ln in lines:
        parts = str(ln).split()
        if len(parts) < 4:
            continue
        t, price = parts[0], float(parts[1])
        cum_vol = float(parts[2])
        cum_amt = float(parts[3])
        hhmm = t.strip().zfill(4)
        ts = f"{d} {hhmm[:2]}:{hhmm[2:]}"
        rows.append({
            "datetime": ts,
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "volume": max(cum_vol - prev_vol, 0.0),
            "amount": max(cum_amt - prev_amt, 0.0),
        })
        prev_vol, prev_amt = cum_vol, cum_amt
    if not rows:
        return d, pl.DataFrame()
    df = pl.DataFrame(rows).with_columns(
        pl.col("datetime").str.to_datetime("%Y-%m-%d %H:%M", strict=False).alias("datetime")
    ).drop_nulls(subset=["datetime"])
    return d, df


def fetch_intraday(symbol: str) -> tuple[str, pl.DataFrame]:
    """拉取当日分时。返回 (会话日期, DataFrame)。美股自动探测交易所后缀。"""
    region = get_region(symbol)
    tcode = _tencent_code(symbol)
    payload = _http_get_json(_TENCENT_URL.format(code=tcode))
    d, df = _parse_tencent_minutes(payload or {}, tcode) if payload else ("", pl.DataFrame())
    if not df.is_empty():
        if region == US:
            _us_suffix_cache[symbol] = _US_SUFFIXES[0]
        return d, df
    if region == US and symbol not in _us_suffix_cache:
        for suffix in _US_SUFFIXES[1:]:
            alt = f"us{symbol.split('.', 1)[0]}{suffix}"
            payload = _http_get_json(_TENCENT_URL.format(code=alt))
            d, df = _parse_tencent_minutes(payload or {}, alt) if payload else ("", pl.DataFrame())
            if not df.is_empty():
                _us_suffix_cache[symbol] = suffix
                break
    return d, df


# ---------------------------------------------------------------- 落盘


def _store_dir(data_dir: Path) -> Path:
    p = data_dir / "kline_minute_hk_us"
    p.mkdir(parents=True, exist_ok=True)
    return p


def persist_intraday(data_dir: Path, symbol: str, session_date: str, df: pl.DataFrame) -> None:
    if df.is_empty():
        return
    out = _store_dir(data_dir) / f"{session_date.replace('-', '')}.parquet"
    df = df.with_columns(pl.lit(symbol).alias("symbol"))
    if out.exists():
        try:
            old = pl.read_parquet(out).filter(pl.col("symbol") != symbol)
            df = pl.concat([old, df], how="diagonal_relaxed")
        except Exception as e:  # noqa: BLE001
            logger.warning("read %s failed, overwrite: %s", out, e)
    df.write_parquet(out)


def load_intraday(data_dir: Path, symbol: str, session_date: str) -> pl.DataFrame:
    out = _store_dir(data_dir) / f"{session_date.replace('-', '')}.parquet"
    if not out.exists():
        return pl.DataFrame()
    try:
        return (
            pl.read_parquet(out)
            .filter(
                (pl.col("symbol") == symbol)
                & (pl.col("datetime").dt.date() == date.fromisoformat(session_date))
            )
            .sort("datetime")
            .drop("symbol")
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("load hk/us minute %s failed: %s", out, e)
        return pl.DataFrame()


# ---------------------------------------------------------------- 当日已看清单


def _viewed_path(user_data_dir: Path) -> Path:
    user_data_dir.mkdir(parents=True, exist_ok=True)
    return user_data_dir / "hk_us_intraday_viewed.json"


def _today_iso() -> str:
    return datetime.now(HK_TZ).date().isoformat()


def get_viewed_today(user_data_dir: Path) -> set[str]:
    path = _viewed_path(user_data_dir)
    try:
        obj = json.loads(path.read_text("utf-8"))
        if obj.get("date") == _today_iso():
            return set(obj.get("symbols") or [])
    except Exception:  # noqa: BLE001
        pass
    return set()


def mark_viewed(user_data_dir: Path, symbol: str) -> None:
    today = _today_iso()
    with _viewed_lock:
        path = _viewed_path(user_data_dir)
        try:
            obj = json.loads(path.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            obj = {}
        if obj.get("date") != today:
            obj = {"date": today, "symbols": []}
        symbols = list(dict.fromkeys([*(obj.get("symbols") or []), symbol]))
        path.write_text(json.dumps({"date": today, "symbols": symbols}, ensure_ascii=False), "utf-8")


# ---------------------------------------------------------------- 后台自动刷新


def refresh_viewed_once(data_dir: Path, user_data_dir: Path) -> int:
    """刷新一轮「当日已看」标的。仅在对应市场开市时段请求。返回刷新只数。"""
    from app.services import preferences

    if not preferences.get_hk_us_intraday_enabled():
        return 0
    refreshed = 0
    for symbol in get_viewed_today(user_data_dir):
        region = get_region(symbol)
        if region not in (HK, US):
            continue
        tz = HK_TZ if region == HK else US_EASTERN_TZ
        now_local = datetime.now(tz)
        # 收盘后 (当地 16:15) 不再刷新
        if now_local.hour > 16 or (now_local.hour == 16 and now_local.minute > 15):
            continue
        if not market_open_now(region):
            continue
        try:
            d, df = fetch_intraday(symbol)
            if not df.is_empty():
                persist_intraday(data_dir, symbol, d, df)
                refreshed += 1
        except Exception as e:  # noqa: BLE001
            logger.warning("auto refresh %s failed: %s", symbol, e)
    return refreshed


def start_background_refresh(data_dir: Path, user_data_dir: Path) -> None:
    """启动后台刷新线程 (daemon, 进程退出自动结束)。幂等。"""
    global _refresh_thread
    if _refresh_thread is not None and _refresh_thread.is_alive():
        return
    _refresh_stop.clear()

    def _loop() -> None:
        while not _refresh_stop.wait(_REFRESH_INTERVAL_S):
            try:
                refresh_viewed_once(data_dir, user_data_dir)
            except Exception as e:  # noqa: BLE001
                logger.warning("hk/us intraday refresh loop error: %s", e)

    _refresh_thread = threading.Thread(target=_loop, daemon=True, name="hk-us-intraday-refresh")
    _refresh_thread.start()
    logger.info("hk/us intraday background refresh started (interval %ss)", _REFRESH_INTERVAL_S)


def stop_background_refresh() -> None:
    _refresh_stop.set()


# ---------------------------------------------------------------- 统一入口 (API 用)


def get_intraday_for_api(symbol: str, data_dir: Path, user_data_dir: Path) -> dict[str, Any]:
    """API 入口: 拉取当日分时, 落盘, 标记已看。优先实时, 失败回退本地。"""
    d, df = fetch_intraday(symbol)
    if not df.is_empty():
        persist_intraday(data_dir, symbol, d, df)
        mark_viewed(user_data_dir, symbol)
        return {"date": d, "rows": df.to_dicts(), "source": "live"}

    stored = load_intraday(data_dir, symbol, _today_iso())
    if stored.is_empty():
        return {"date": _today_iso(), "rows": [], "source": "none"}
    return {"date": _today_iso(), "rows": stored.to_dicts(), "source": "local"}


def region_today(region: str) -> str:
    tz = HK_TZ if region == HK else US_EASTERN_TZ
    return datetime.now(tz).date().isoformat()

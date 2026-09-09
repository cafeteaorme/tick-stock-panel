"""同花顺投资账本 (tzzb.10jqka.com.cn) 同步。

页面为登录制 JS 应用, 无公开 API。本模块持久化用户提供的登录 Cookie,
并用其探测账本数据接口; 探测成功后可拉取账户名/持仓, 落地为本地账户与快照。

Cookie 获取方式: 浏览器登录 tzzb.10jqka.com.cn → F12 → Network → 任意请求
→ 复制 Request Headers 里整段 Cookie 粘贴到设置。
接口为非官方形态, 可能随同花顺改版失效——同步失败时刷新/重贴 Cookie。
"""
from __future__ import annotations

import ipaddress
import hashlib
import json
import logging
import re
import socket
import threading
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from app.config import settings
from app.market_time import CN_TZ, HK_TZ

import polars as pl

logger = logging.getLogger(__name__)

_ALLOWED_HOST = "tzzb.10jqka.com.cn"
_TIMEOUT = 20
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 候选数据端点 (无公开文档, 按常见形态探测; 命中即缓存到本地配置)
_CANDIDATE_ENDPOINTS = [
    # 从 tzzb 前端子应用 (tzzbWeb/summary/calendarPage.html 等) 抓包确认的真实路径
    "/caishen_fund/stock/getAccounts",
    "/caishen_fund/stock/index",
    "/caishen_fund/stock/profitlossByCode",
    "/caishen_fund/stockSummary/judgeHkStock",
]


def _store_path() -> Path:
    p = settings.data_dir / "user_data" / "tzzb.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def load_config() -> dict[str, Any]:
    try:
        return json.loads(_store_path().read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return {"cookie": "", "endpoint": "", "user_name": "", "last_sync": None, "last_result": ""}


def save_config(**updates: Any) -> dict[str, Any]:
    import os
    cfg = load_config()
    cfg.update(updates)
    tmp = _store_path().with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, _store_path())
    return cfg


def _assert_safe(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "").lower() != _ALLOWED_HOST:
        raise ValueError("仅允许访问 tzzb.10jqka.com.cn (https)")
    for info in socket.getaddrinfo(parts.hostname, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("解析到内网地址, 已拒绝")


def _get(url: str, cookie: str, method: str = "GET") -> tuple[int, str]:
    _assert_safe(url)
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA,
        "Cookie": cookie,
        "Referer": f"https://{_ALLOWED_HOST}/",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/plain, */*",
    }, method=method)
    opener = urllib.request.build_opener(_NoRedirect)
    with opener.open(req, timeout=_TIMEOUT) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


def _probe_hit(status: int, body: str) -> bool:
    """命中判定: 200 + JSON 对象/数组, 且不是登录跳转/错误壳。"""
    if status != 200:
        return False
    t = body.strip()
    if not (t.startswith("{") or t.startswith("[")):
        return False
    try:
        obj = json.loads(t)
    except Exception:  # noqa: BLE001
        return False
    flat = json.dumps(obj, ensure_ascii=False)
    bad = ("passport", "login.html", '"\u767b\u5f55"')  # 登录页跳转特征
    if any(b in flat for b in bad) and "data" not in obj if isinstance(obj, dict) else False:
        return False
    return True


def probe_endpoints(cookie: str) -> tuple[str | None, str]:
    """依次探测候选端点 (GET 未中补 POST), 返回 (命中的端点, 响应样本)。"""
    samples: list[str] = []
    for ep in _CANDIDATE_ENDPOINTS:
        url = f"https://{_ALLOWED_HOST}{ep}"
        for method in ("GET", "POST"):
            try:
                status, body = _get(url, cookie, method=method)
            except Exception as e:  # noqa: BLE001
                logger.debug("probe %s %s err: %s", method, ep, e)
                continue
            if _probe_hit(status, body):
                return ep, body[:2000]
            samples.append(f"{method} {ep} -> {status} {body[:80]!r}")
    return None, "；".join(samples[-4:]) if samples else "全部端点请求失败"


# 交易日 (周一至五) 北京时间 9:31 / 16:05 各同步一次
_SYNC_SLOTS = [(9, 31), (16, 5)]
_HK_REFRESH_S = 60
_hk_thread: threading.Thread | None = None
_hk_stop = threading.Event()


def start_hk_price_refresh() -> bool:
    """持仓含港股且港股开市时段, 每 60s 用 TickFlow quotes 刷新价格并落库 (面板 quote 规则)。"""
    global _hk_thread
    if _hk_thread is not None and _hk_thread.is_alive():
        return False
    _hk_stop.clear()

    def _loop() -> None:
        import time as _time

        import polars as _pl

        from app.market_time import HK_TZ, US_EASTERN_TZ, market_open_now
        from app.services import holdings as holdings_svc
        from app.tickflow.client import get_client

        tf = get_client()
        while not _hk_stop.wait(_HK_REFRESH_S):
            try:
                obj = holdings_svc.list_accounts()
                hk_syms: dict[str, str] = {}
                for a in obj["accounts"]:
                    for r in holdings_svc.list_all(a["id"]):
                        if str(r["symbol"]).endswith(".HK") and float(r.get("qty") or 0) > 0:
                            hk_syms.setdefault(r["symbol"], a["id"])
                if not hk_syms or not market_open_now("HK"):
                    continue
                raw = tf.quotes.get(symbols=list(hk_syms), as_dataframe=True)
                if raw is None or len(raw) == 0:
                    continue
                df = raw if isinstance(raw, _pl.DataFrame) else _pl.from_pandas(raw)
                for rec in df.to_dicts():
                    sym = rec.get("symbol")
                    price = rec.get("last_price")
                    if not sym or price is None:
                        continue
                    acc_id = hk_syms[sym]
                    h = holdings_svc.get(acc_id, sym)
                    qty = float(h.get("qty") or 0) if h else 0.0
                    cost = h.get("avg_cost") if h else None
                    pct = None
                    ext = rec.get("ext.change_pct")
                    try:
                        pct = float(ext) if ext is not None else None
                    except (TypeError, ValueError):
                        pct = None
                    holdings_svc.upsert(acc_id, sym, qty, qty, cost,
                                        extras={"price": _fin(price), "change_pct": pct})
                logger.info("tzzb hk price refresh: %d symbols", len(hk_syms))
            except Exception as e:  # noqa: BLE001
                logger.warning("tzzb hk refresh error: %s", e)

    _hk_thread = threading.Thread(target=_loop, daemon=True, name="tzzb-hk-refresh")
    _hk_thread.start()
    logger.info("tzzb hk price refresh started (60s, HK market hours)")
    return True


def _current_qty(holdings_svc, account_id: str, symbol: str) -> float:
    h = holdings_svc.get(account_id, symbol)
    return float(h.get("qty") or 0) if h else 0.0
_SYNC_CHECK_S = 20
_sync_thread: threading.Thread | None = None
_sync_stop = threading.Event()
_synced_marker = ""  # "date:slot" 防同日同时点重复执行


def start_background_sync() -> bool:
    """交易日凌晨外常驻检查线程, 到 9:31/16:05 时点自动同步一次。幂等。"""
    global _sync_thread
    if _sync_thread is not None and _sync_thread.is_alive():
        return False
    _sync_stop.clear()

    def _loop() -> None:
        global _synced_marker
        from app.market_time import CN_TZ

        while not _sync_stop.wait(_SYNC_CHECK_S):
            try:
                now = datetime.now(CN_TZ)
                if now.weekday() >= 5:  # 周末
                    continue
                slot = (now.hour, now.minute)
                if slot not in _SYNC_SLOTS:
                    continue
                marker = f"{now.date().isoformat()}:{slot[0]:02d}:{slot[1]:02d}"
                if _synced_marker == marker:
                    continue
                cfg = load_config()
                if not (cfg.get("cookie") or "").strip() and not _cdp_port_alive():
                    continue  # 未配置, 静默跳过
                # 节假日判断: 账本交易日接口 (失败时兜底继续)
                ltd = _last_trading_day_info()
                if ltd is not None and not ltd.get("is_trading_day"):
                    _synced_marker = marker
                    logger.info("tzzb sync skip: %s 非交易日", now.date().isoformat())
                    continue
                _synced_marker = marker
                res = sync()
                fetch_hk_rate()
                logger.info("tzzb scheduled sync %s: %s", marker, res.get("message", "")[:120])
            except Exception as e:  # noqa: BLE001
                logger.warning("tzzb scheduled sync error: %s", e)

    _sync_thread = threading.Thread(target=_loop, daemon=True, name="tzzb-scheduled-sync")
    _sync_thread.start()
    logger.info("tzzb scheduled sync started (trading days 09:31/16:05 CST)")
    return True


_API_BASE = "https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb"


_CDP_PORT = 9223
_PROFILE_DIR = "chrome_tzzb_profile"


# ---------------------------------------------------------------- CDP 数据桥
# 投资账本接口带 JS 反爬 token, 脚本直接复现会被 400 拒绝。
# 改由专用 Chrome 页面自己加载数据, CDP 捕获真实响应体。


def _cdp_new_tab(url: str) -> None:
    import urllib.request as _ur

    opener = _ur.build_opener(_ur.ProxyHandler({}))
    req = _ur.Request(f"http://127.0.0.1:{_CDP_PORT}/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
    opener.open(req, timeout=10).read()


def _cdp_wait_page(timeout_s: float = 15) -> dict:
    import time as _time

    deadline = _time.time() + timeout_s
    while _time.time() < deadline:
        for t in _cdp_json("/json/list"):
            if t.get("type") == "page":
                return t
        _time.sleep(0.5)
    raise RuntimeError("CDP 无可用页面")


def _cdp_capture(page_url: str, patterns: tuple[str, ...], wait_s: float = 12) -> dict[str, str]:
    """打开页面, 捕获命中 patterns 的 XHR 响应体。返回 {url: body}。"""
    import time as _time

    import websocket

    _cdp_new_tab(page_url)
    time.sleep(1.0)
    targets = _cdp_json("/json/list")
    page = next((t for t in targets if t.get("type") == "page"
                 and page_url.split("?")[0][-30:] in (t.get("url") or "")), None)
    if not page:
        page = next((t for t in targets if t.get("type") == "page"), None)
    if not page:
        raise RuntimeError("CDP 无可用页面")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=int(wait_s + 10),
                                     suppress_origin=True)
    bodies: dict[str, str] = {}
    pending: dict[str, str] = {}  # requestId -> url
    try:
        ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
        ws.send(json.dumps({"id": 2, "method": "Page.reload"}))
        deadline = _time.time() + wait_s
        ws.settimeout(1.0)
        while _time.time() < deadline:
            try:
                msg = json.loads(ws.recv())
            except Exception:
                continue
            meth = msg.get("method")
            params = msg.get("params") or {}
            if meth == "Network.requestWillBeSent":
                u = params.get("request", {}).get("url", "")
                if any(p in u for p in patterns):
                    pending[params["requestId"]] = u
            elif meth == "Network.loadingFinished" and params.get("requestId") in pending:
                rid = params["requestId"]
                u = pending.pop(rid)
                try:
                    rb = json.loads(json.dumps({"id": 100, "method": "Network.getResponseBody",
                                                "params": {"requestId": rid}}))
                    ws.send(json.dumps(rb))
                    # 响应在后续 recv 到来 — 记入待匹配
                except Exception:  # noqa: BLE001
                    pass
                bodies[u] = "__pending__" + rid
        # 收集所有响应体 (统一再取一轮)
        result = {}
        for rid, u in list(pending.items()):
            try:
                rb = json.dumps({"id": 500, "method": "Network.getResponseBody",
                                 "params": {"requestId": rid}})
                ws.send(rb)
            except Exception:  # noqa: BLE001
                pass
        _time.sleep(1.0)
        return bodies if bodies else {}
    finally:
        ws.close()


def _cdp_cookie() -> str:
    import math
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def open_login_window() -> dict[str, Any]:
    """打开专用 Chrome 配置目录的登录窗口 (登录一次, 配置目录长期记住登录态)。"""
    import subprocess

    profile = settings.data_dir / _PROFILE_DIR
    profile.mkdir(parents=True, exist_ok=True)
    subprocess.Popen([
        "open", "-na", "Google Chrome", "--args",
        f"--user-data-dir={profile}",
        f"--remote-debugging-port={_CDP_PORT}",
        "--no-first-run", "--no-default-browser-check",
        "https://tzzb.10jqka.com.cn/pc/index.html",
    ])
    return {"ok": True, "message": "已打开专用 Chrome 登录窗口，请在窗口内登录投资账本（登录一次即可，之后自动同步）"}


def _cdp_json(path: str) -> Any:
    import urllib.request as _ur

    opener = _ur.build_opener(_ur.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{_CDP_PORT}{path}", timeout=8) as r:
        return json.loads(r.read().decode("utf-8"))


def _cdp_port_alive() -> bool:
    try:
        _cdp_json("/json/version")
        return True
    except Exception:  # noqa: BLE001
        return False


def fetch_cookies_via_cdp() -> str:
    """通过 CDP 读取专用 Chrome 的全部 10jqka Cookie (含 httpOnly)。返回 cookie 串。

    端口未起 (用户窗口已关) → 无头拉起同一配置目录自动完成。
    """
    import time as _time
    import websocket

    if not _cdp_port_alive():
        profile = settings.data_dir / _PROFILE_DIR
        profile.mkdir(parents=True, exist_ok=True)
        subprocess.Popen([
            "open", "-na", "Google Chrome", "--args",
            f"--user-data-dir={profile}",
            f"--remote-debugging-port={_CDP_PORT}",
            "--headless=new", "--no-first-run", "about:blank",
        ])
        for _ in range(20):
            _time.sleep(1)
            if _cdp_port_alive():
                break
        else:
            raise RuntimeError("无法启动 Chrome 调试端口 (若该窗口开着请先关闭后重试)")

    # 无页面目标时自动新建 (专用 Chrome 窗口被关闭后的情况)
    if not any(t.get("type") == "page" for t in _cdp_json("/json/list")):
        import urllib.request as _ur

        opener = _ur.build_opener(_ur.ProxyHandler({}))
        req = _ur.Request(f"http://127.0.0.1:{_CDP_PORT}/json/new?about:blank", method="PUT")
        opener.open(req, timeout=10)
        _time.sleep(1)
    targets = _cdp_json("/json/list")
    page = next((t for t in targets if t.get("type") == "page"), None)
    if not page:
        raise RuntimeError("CDP 无可用页面")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": "Network.getAllCookies"}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                cookies = (msg.get("result") or {}).get("cookies") or []
                break
    finally:
        ws.close()
    pairs = [f"{c['name']}={c['value']}" for c in cookies if "10jqka" in (c.get("domain") or "")]
    if not pairs:
        raise RuntimeError("专用 Chrome 中未发现 10jqka Cookie (请先在该窗口登录投资账本)")
    return "; ".join(pairs)


def _api(ep: str, cookie: str, params: dict) -> dict:
    import urllib.parse

    qs = urllib.parse.urlencode({**params,
        "terminal": "1", "version": "0.0.0", "userid": _uid(cookie), "user_id": _uid(cookie)})
    url = f"{_API_BASE}{ep}?{qs}"
    status, body = _get(url, cookie)
    if status != 200:
        raise RuntimeError(f"{ep} HTTP {status}")
    obj = json.loads(body)
    if str(obj.get("error_code")) != "0":
        raise RuntimeError(f"{ep} error_code={obj.get('error_code')} {str(obj.get('error_msg'))[:80]}")
    return obj.get("ex_data") or {}


def _uid(cookie: str) -> str:
    m = re.search(r"(?:^|;\s*)userid=([^;]+)", cookie)
    return m.group(1) if m else ""


def _cdp_cookie() -> str:
    try:
        return fetch_cookies_via_cdp()
    except Exception:
        cfg = load_config()
        saved = (cfg.get("cookie") or "").strip()
        if saved:
            return saved
        raise


def _market_suffix(market: str, code: str) -> str:
    """严格映射: HK 仅 5 位数字码; 6 位数字码按开头归沪深; 北交 12/144。"""
    code = code.strip()
    if len(code) == 5 and code.isdigit():
        return ".HK"
    if len(code) == 6 and code.isdigit():
        if code.startswith(("6", "5", "9")):
            return ".SH"
        if code.startswith(("0", "3")):
            return ".SZ"
        if code.startswith(("4", "8")):
            return ".BJ"
    # 兜底按 tzzb market 字段
    if market in ("176", "177", "178", "179", "180", "181", "182", "183"):
        return ".HK"
    if market == "2":
        return ".SH"
    if market == "1":
        return ".SZ"
    if market == "12":
        return ".BJ"
    logger.warning("未知市场代码 market=%s code=%s, 默认 .SZ", market, code)
    return ".SZ"


_HIST_NAME = "tzzb_history.json"


def _hist_path() -> Path:
    return settings.data_dir / "user_data" / _HIST_NAME


def history_status() -> dict[str, Any]:
    try:
        obj = json.loads(_hist_path().read_text("utf-8"))
        return {"cached": bool(obj.get("ok")), "date": obj.get("date"),
                "days": len(obj.get("daily") or []), "fetched_at": obj.get("fetched_at")}
    except Exception:  # noqa: BLE001
        return {"cached": False, "date": None, "days": 0, "fetched_at": None}


def _atomic_write_json(path: Path, payload: dict) -> None:
    import os

    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, path)


def _f_pl(v) -> float | None:
    import math

    try:
        f = float(str(v).replace(",", "").replace("HK$", "").replace("$", ""))
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _last_trading_day_info() -> dict | None:
    """当日是否交易日 + 相邻交易日 (缓存当日结果)。"""
    today = datetime.now(HK_TZ).date().isoformat()
    cache_key = f"_ltd_{today}"
    cfg = load_config()
    if cfg.get(cache_key):
        return cfg.get(cache_key)
    cookie = (cfg.get("cookie") or "").strip()
    if not cookie:
        return None
    try:
        ex = _api("/caishen_fund/stock_common/v1/last_trading_day", cookie, {})
        info = {
            "is_trading_day": int(ex.get("is_trading_day") or 0),
            "last": ex.get("last_trading_day"),
            "prev": ex.get("prev_trading_day"),
            "next": ex.get("next_trading_day"),
        }
        cfg[cache_key] = info
        save_config(**{cache_key: info})
        return info
    except Exception as e:  # noqa: BLE001
        logger.warning("last_trading_day failed: %s", e)
        return None


def fetch_hk_rate() -> dict | None:
    """账本港币汇率 (当日+前日)。成功存入 config 缓存。"""
    cookie = (load_config().get("cookie") or "").strip()
    if not cookie:
        return None
    try:
        ex = _api("/caishen_fund/stock_common/v1/hk_rate", cookie,
                  {"date": datetime.now(HK_TZ).strftime("%Y%m%d")})
        rate = _f_pl(ex.get("rate"))
        before = _f_pl(ex.get("before_rate"))
        if rate:
            save_config(hk_rate=rate, hk_rate_before=before,
                        hk_rate_date=datetime.now(HK_TZ).date().isoformat())
            # 自动值写入 preferences (手动覆盖值存于 holdings_hk_rate_manual 时优先)
            try:
                from app.services import preferences

                if preferences.load().get("holdings_hk_rate_source", "auto") == "auto":
                    preferences.save({"holdings_hk_rate": rate,
                                      "holdings_hk_rate_source": "auto",
                                      "holdings_hk_rate_date": datetime.now(HK_TZ).date().isoformat()})
            except Exception:  # noqa: BLE001
                pass
            return {"rate": rate, "before": before}
    except Exception as e:  # noqa: BLE001
        logger.warning("hk_rate fetch failed: %s", e)
    return None


def is_trading_day_today() -> bool:
    info = _last_trading_day_info()
    if info is None:
        # 接口不可用 → 周一至五视为交易日 (兜底)
        return datetime.now(HK_TZ).date().weekday() < 5
    return bool(info.get("is_trading_day"))


def fetch_history_cache() -> dict[str, Any]:
    """拉取投资账本历史收益 (逐账户×逐年 month_calendar → profit_loss_list 月度权威值)。"""
    cookie = _cdp_cookie()
    save_config(cookie=cookie)
    accounts_raw = _api("/caishen_fund/pc/account/v1/account_list", cookie, {})
    fund_keys = [str(b.get("fund_key")) for b in (accounts_raw.get("common") or [])
                 if b.get("fund_key")]

    monthly_acc: dict[str, float] = {}
    this_year = datetime.now(HK_TZ).date().year
    fetched_months = 0
    for fk in fund_keys:
        for y in (this_year - 1, this_year, this_year - 2):
            params = {"year": str(y), "type": "common", "fund_key": fk,
                      "terminal": "123", "version": "11"}
            try:
                ex = _api("/caishen_fund/calendar/v1/month_calendar", cookie, params)
            except Exception as e:  # noqa: BLE001
                logger.warning("tzzb month_calendar %s %d failed: %s", fk, y, e)
                continue
            for row in ex.get("profit_loss_list") or []:
                d = str(row.get("date") or "")
                if len(d) != 6:
                    continue
                pl_v = _f_pl(row.get("profit_loss"))
                if pl_v is None:
                    continue
                period = f"{d[:4]}-{d[4:6]}"
                monthly_acc[period] = round(monthly_acc.get(period, 0) + pl_v, 2)
                fetched_months += 1

    if not monthly_acc:
        payload = {"ok": False, "date": datetime.now(HK_TZ).date().isoformat(),
                   "monthly": [], "yearly": [],
                   "message": "未拉取到历史收益数据（账户无记录或接口变化）"}
        _atomic_write_json(_hist_path(), payload)
        return {"ok": False, "message": payload["message"]}

    yearly: dict[str, float] = {}
    for period, v in monthly_acc.items():
        yearly[period[:4]] = round(yearly.get(period[:4], 0) + v, 2)

    # 真实资产趋势 (含出入金): 逐账户 asset_trend 按日合并
    trend: dict[str, dict] = {}
    for fk in fund_keys:
        try:
            ex = _api("/caishen_fund/pc/asset/v1/asset_trend", cookie,
                      {"fund_key": fk, "type": "common"})
        except Exception as e:  # noqa: BLE001
            logger.warning("asset_trend %s failed: %s", fk, e)
            continue
        for row in ex.get("total_asset") or []:
            d = str(row.get("date") or "")
            if len(d) != 8:
                continue
            iso = f"{d[:4]}-{d[4:6]}-{d[6:]}"
            cur = trend.setdefault(iso, {"asset": 0.0, "fundIn": 0.0, "fundOut": 0.0})
            cur["asset"] += _f_pl(row.get("asset")) or 0
            cur["fundIn"] += _f_pl(row.get("fundIn")) or 0
            cur["fundOut"] += _f_pl(row.get("fundOut")) or 0
    trend_list = [{"date": k, **{kk: round(vv, 2) for kk, vv in v.items()}} for k, v in sorted(trend.items())]

    payload = {
        "ok": True,
        "date": datetime.now(HK_TZ).date().isoformat(),
        "fetched_at": datetime.utcnow().isoformat(timespec="seconds"),
        "monthly": [{"period": k, "pnl": v} for k, v in sorted(monthly_acc.items())],
        "yearly": [{"period": k, "pnl": v} for k, v in sorted(yearly.items())],
        "asset_trend": trend_list,
        "trading_day_info": _last_trading_day_info(),
    }
    _atomic_write_json(_hist_path(), payload)
    return {"ok": True, "message": f"历史收益缓存成功：{len(monthly_acc)} 个月（{fetched_months} 条记录），资产趋势 {len(trend_list)} 天"}


def sync(account_id: str | None = None) -> dict[str, Any]:
    """同步投资账本: CDP 取 Cookie → 遍历券商账户 → 持仓写入本地 (当日持仓 + 快照)。"""
    from app.services import holdings as holdings_svc
    from app.services import watchlist as wl

    cookie = _cdp_cookie()
    save_config(cookie=cookie)

    accounts_raw = _api("/caishen_fund/pc/account/v1/account_list", cookie, {})
    brokers = (accounts_raw.get("common") or []) + (accounts_raw.get("rzrq") or [])

    today = datetime.utcnow().date().isoformat()
    synced_accounts = []
    total_positions = 0

    for b in brokers:
        fund_key = str(b.get("fund_key") or "")
        if not fund_key:
            continue
        raw_name = (b.get("brokername") or b.get("manualname") or fund_key).strip()
        # 本地账户: 按名称匹配, 无则创建
        acc_id = holdings_svc.find_account_by_name(raw_name) or holdings_svc.create_account(raw_name)["id"]

        pos_raw = _api("/caishen_fund/pc/asset/v1/stock_position", cookie,
                       {"fund_key": fund_key, "type": "common"})
        positions = pos_raw.get("position") or []
        cash = float(pos_raw.get("money_remain") or 0)

        def _f(v):
            try:
                return float(re.sub(r"^(?:HK|US|CNY)?[$¥]", "", str(v).strip(), flags=re.IGNORECASE).replace(",", ""))
            except (TypeError, ValueError):
                return None
        holdings_rows = []
        for p in positions:
            code = str(p.get("code") or "").strip()
            market = str(p.get("market") or "")
            if not code:
                continue
            symbol = code + _market_suffix(market, code)
            qty = float(p.get("count") or 0)
            cost = float(p.get("cost") or 0)
            extras = {
                "price": _f(p.get("price")),
                "change_pct": _f(p.get("pre_rate")),
                "hold_days": _f(p.get("hold_days")),
                "position_rate": _f(p.get("position_rate")),
                "pre_profit": _f(p.get("pre_profit")),
                "pre_rate": _f(p.get("pre_rate")),
                "hold_profit": _f(p.get("hold_profit")),
                "hold_rate": _f(p.get("hold_rate")),
                "m1_rate": _f(p.get("m1_rate")),
                "m3_rate": _f(p.get("m3_rate")),
                "m6_rate": _f(p.get("m6_rate")),
                "m12_rate": _f(p.get("m12_rate")),
            }
            if qty > 0:
                holdings_svc.upsert(acc_id, symbol, qty, qty, cost, extras, source="tzzb")
            else:
                # 已清仓 (数量 0): 记为 closed, 保留成本与已实现盈亏未知
                h = holdings_svc.get(acc_id, symbol)
                if h:  # 本地原持有 → 转清仓
                    holdings_svc.sell(acc_id, symbol, _f(p.get("price")) or _f(cost) or 0)
                else:
                    holdings_svc.upsert(acc_id, symbol, 0, 0, cost,
                                        {"status": "closed", "closed_at": datetime.utcnow().isoformat(timespec="seconds")})
            if symbol not in {r["symbol"] for r in wl.list_symbols()}:
                wl.add(symbol)
            holdings_rows.append({"symbol": symbol, "qty": qty, "available": qty,
                                  "avg_cost": cost or None})
        # 清理失效行: 仅删除 tzzb 来源的失效行 (手动/截图来源受保护)
        valid = {r["symbol"] for r in holdings_rows}
        stale = holdings_svc.remove_stale_tzzb(acc_id, valid)
        if stale:
            logger.info("tzzb sync 清理失效持仓 %s: %s", raw_name, stale)
        holdings_svc.set_portfolio(acc_id, cash=cash)
        holdings_svc.save_snapshot(acc_id, today, cash=cash)
        synced_accounts.append({"name": raw_name, "account_id": acc_id,
                                "positions": len(holdings_rows), "cash": cash})
        total_positions += len(holdings_rows)

    save_config(last_sync=datetime.utcnow().isoformat(timespec="seconds"),
                last_result=f"同步 {len(synced_accounts)} 账户 {total_positions} 条持仓", last_ok=True)
    return {"ok": True, "message": f"同步成功：{len(synced_accounts)} 个账户，共 {total_positions} 条持仓",
            "accounts": synced_accounts}


# ---------------------------------------------------------------- AI 报告持久化


def _reports_path() -> Path:
    p = settings.data_dir / "user_data" / "tzzb_reports.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def list_reports() -> list[dict]:
    try:
        obj = json.loads(_reports_path().read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return []
    return sorted(obj.get("reports") or [], key=lambda r: r.get("saved_at", ""), reverse=True)


def save_report(date: str, content: str, summary: str | None = None) -> dict:
    rep = {"id": f"r_{int(datetime.utcnow().timestamp()*1000)}", "date": date,
           "content": content, "summary": summary,
           "saved_at": datetime.utcnow().isoformat(timespec="seconds")}
    obj = {"reports": list_reports()}
    obj["reports"].append(rep)
    _reports_path().write_text(json.dumps(obj, ensure_ascii=False, indent=1), "utf-8")
    return rep


def delete_report(report_id: str) -> dict:
    obj = {"reports": [r for r in list_reports() if r.get("id") != report_id]}
    _reports_path().write_text(json.dumps(obj, ensure_ascii=False), "utf-8")
    return {"ok": True}

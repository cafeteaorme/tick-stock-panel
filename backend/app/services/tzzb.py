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
import subprocess
import threading
import urllib.parse
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
_INTRADAY_SYNC_S = 30 * 60  # 盘中加密同步间隔 (交易时段每 30 分钟)
_last_intraday_sync = 0.0


def _in_trading_session() -> bool:
    """A 股交易时段 (含集合竞价与收盘缓冲): 9:25-11:35 / 12:55-15:05。"""
    from datetime import time as _time

    now = datetime.now(CN_TZ).time()
    return (_time(9, 25) <= now <= _time(11, 35)) or (_time(12, 55) <= now <= _time(15, 5))


def start_background_sync() -> bool:
    """交易日凌晨外常驻检查线程, 到 9:31/16:05 时点自动同步一次。幂等。"""
    global _sync_thread
    if _sync_thread is not None and _sync_thread.is_alive():
        return False
    _sync_stop.clear()

    def _loop() -> None:
        global _synced_marker, _last_intraday_sync
        import time as _time

        from app.market_time import CN_TZ

        while not _sync_stop.wait(_SYNC_CHECK_S):
            try:
                now = datetime.now(CN_TZ)
                if now.weekday() >= 5:  # 周末
                    continue
                # 盘中加密同步: 交易时段每 30 分钟拉一次, 减少账本持仓列表盘中滞后
                if (_in_trading_session() and _time.time() - _last_intraday_sync >= _INTRADAY_SYNC_S
                        and (_cdp_port_alive() or (load_config().get("cookie") or "").strip())):
                    _last_intraday_sync = _time.time()
                    if is_trading_day_today():
                        res = sync()
                        fetch_hk_rate()
                        logger.info("tzzb intraday sync %s: %s", now.strftime("%H:%M"), res.get("message", "")[:120])
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


def _cdp_capture_api(trigger_url: str, patterns: tuple[str, ...], wait_s: float = 15) -> list[dict]:
    """导航到 trigger_url, 捕获页面自身发出的命中 patterns 的接口响应体。

    反爬 token 由页面 JS 自己带上, 我们只旁路截获响应 → 最可靠。
    返回 [{url, post_data, body}], body 为原始字符串。
    """
    import base64  # noqa: F401
    import time as _time

    import websocket

    page = _ensure_tzzb_page()
    ws = websocket.create_connection(page["webSocketDebuggerUrl"],
                                     timeout=int(wait_s + 15), suppress_origin=True)
    results: list[dict] = []
    pending: dict[str, dict] = {}   # requestId -> {url, post_data}
    body_calls: dict[int, dict] = {}  # getResponseBody 调用 id -> entry
    next_id = 100
    try:
        ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
        ws.send(json.dumps({"id": 2, "method": "Page.navigate", "params": {"url": trigger_url}}))
        deadline = _time.time() + wait_s
        ws.settimeout(1.0)
        while _time.time() < deadline:
            try:
                msg = json.loads(ws.recv())
            except Exception:  # noqa: BLE001
                continue
            meth = msg.get("method")
            params = msg.get("params") or {}
            if meth == "Network.requestWillBeSent":
                req = params.get("request") or {}
                u = req.get("url", "")
                if any(p in u for p in patterns):
                    pending[params["requestId"]] = {"url": u,
                                                    "post_data": req.get("postData") or ""}
            elif meth == "Network.loadingFailed" and params.get("requestId") in pending:
                pending.pop(params["requestId"], None)
            elif meth == "Network.loadingFinished" and params.get("requestId") in pending:
                rid = params["requestId"]
                entry = pending.pop(rid)
                cid = next_id
                next_id += 1
                body_calls[cid] = entry
                ws.send(json.dumps({"id": cid, "method": "Network.getResponseBody",
                                    "params": {"requestId": rid}}))
            elif "id" in msg and msg["id"] in body_calls and "result" in msg:
                entry = body_calls.pop(msg["id"])
                res = msg.get("result") or {}
                body = res.get("body") or ""
                if res.get("base64Encoded"):
                    body = base64.b64decode(body).decode("utf-8", "replace")
                entry["body"] = body
                results.append(entry)
        return results
    finally:
        ws.close()


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


def _ensure_tzzb_page(wait_s: float = 8) -> dict:
    """确保 CDP 可达且存在 tzzb 页面, 返回该页面 target (页面上下文调用入口)。"""
    import time as _time

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
            raise RuntimeError("无法启动 Chrome 调试端口")

    def _find():
        return next((t for t in _cdp_json("/json/list")
                     if t.get("type") == "page" and "tzzb.10jqka.com.cn" in (t.get("url") or "")), None)

    page = _find()
    if not page:
        _cdp_new_tab("https://tzzb.10jqka.com.cn/pc/index.html")
        deadline = _time.time() + wait_s
        while _time.time() < deadline:
            _time.sleep(1)
            page = _find()
            if page:
                break
    if not page:
        raise RuntimeError("CDP 无 tzzb 页面")
    return page


def _cdp_page_post(ep: str, params: dict, timeout_s: float = 20) -> dict:
    """在专用 Chrome 的 tzzb 页面上下文里发 POST。

    实测要点: 必须用相对 URL + axios 同款 Accept 头, 否则被 WAF 403
    ("请求失败，请稍后重试")。用于 GET 探测不通的接口
    (stock_history_query / clear_position_query 等)。
    """
    import time as _time

    import websocket

    page = _ensure_tzzb_page()
    ws = websocket.create_connection(page["webSocketDebuggerUrl"],
                                     timeout=int(timeout_s + 10), suppress_origin=True)
    body = urllib.parse.urlencode(params)
    expr = (
        "(async () => {"
        "  try {"
        f"    const r = await fetch('/caishen_httpserver/tzzb{ep}', {{"
        "      method: 'POST',"
        "      headers: {"
        "        'Content-Type': 'application/x-www-form-urlencoded',"
        "        'Accept': 'application/json, text/plain, */*'"
        "      },"
        f"      body: {json.dumps(body)}"
        "    });"
        "    return await r.text();"
        "  } catch (e) { return JSON.stringify({error_code: 'network', error_msg: String(e)}); }"
        "})()"
    )
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                            "params": {"expression": expr, "awaitPromise": True,
                                       "returnByValue": True}}))
        deadline = _time.time() + timeout_s
        while _time.time() < deadline:
            try:
                msg = json.loads(ws.recv())
            except Exception:  # noqa: BLE001
                continue
            if msg.get("id") == 2:
                res = (msg.get("result") or {}).get("result") or {}
                if res.get("type") != "string":
                    raise RuntimeError(f"{ep} 页面调用失败: {json.dumps(msg.get('result'))[:200]}")
                obj = json.loads(res["value"])
                if str(obj.get("error_code")) != "0":
                    raise RuntimeError(f"{ep} error_code={obj.get('error_code')} {str(obj.get('error_msg'))[:80]}")
                return obj.get("ex_data") or {}
        raise RuntimeError(f"{ep} 页面调用超时")
    finally:
        ws.close()


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
    # 月度累计盈亏曲线 (账本权威, 全历史; 无需本金即可看复利轨迹)
    cum = 0.0
    curve = []
    for k, v in sorted(monthly_acc.items()):
        cum = round(cum + v, 2)
        curve.append({"period": k, "pnl": v, "cum": cum})
    payload["curve"] = curve
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
    _tc = load_trades_cache()  # 派生清仓轮次: 回填真实清仓时间/已实现

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
                # 已清仓 (数量 0): 本地原持有 → 卖出转清仓; 无持仓 → 用账本成交派生的真实清仓日/已实现落行
                h = holdings_svc.get(acc_id, symbol)
                if h:
                    holdings_svc.sell(acc_id, symbol, _f(p.get("price")) or _f(cost) or 0)
                else:
                    _rounds = [c for c in (_tc.get("cleared") or [])
                               if c.get("account_id") == fund_key and c.get("symbol") == symbol]
                    rnd = max(_rounds, key=lambda c: c.get("last_sell") or "") if _rounds else None
                    closed_at = f"{rnd['last_sell']}T00:00:00" if rnd and rnd.get("last_sell") \
                        else datetime.utcnow().isoformat(timespec="seconds")
                    holdings_svc.upsert(acc_id, symbol, 0, 0, cost, {
                        "status": "closed", "closed_at": closed_at,
                        "realized_pnl": rnd.get("profit") if rnd else None,
                    })
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

    # 成交/清仓缓存 (>12h 才刷新, 异步不阻塞同步)
    if _trades_stale():
        def _safe_fetch_trades():
            try:
                fetch_trades_cache()
            except Exception as e:  # noqa: BLE001
                logger.warning("trades cache refresh failed: %s", e)
        threading.Thread(target=_safe_fetch_trades, daemon=True).start()

    return {"ok": True, "message": f"同步成功：{len(synced_accounts)} 个账户，共 {total_positions} 条持仓",
            "accounts": synced_accounts}


# ---------------------------------------------------------------- 真实成交 / 清仓 / 出入金

_TRADES_NAME = "tzzb_trades.json"


def _trades_path() -> Path:
    return settings.data_dir / "user_data" / _TRADES_NAME


def _trade_symbol(market_code: str, code: str) -> str:
    """成交记录 → 本地 symbol (港 5 位/沪深北 6 位/字母码 → .US)。"""
    code = (code or "").strip()
    if not code:
        return ""
    if code.isdigit():
        return code + _market_suffix(str(market_code or ""), code)
    return code.upper() + ".US"


def _norm_trade(r: dict, acc_name: str) -> dict | None:
    code = str(r.get("stock_code") or "").strip()
    if not code:
        return None
    d = str(r.get("trans_date") or "")
    date = f"{d[:4]}-{d[4:6]}-{d[6:]}" if len(d) == 8 else ""
    if not date:
        return None
    dt = str(r.get("transDateTime") or "")
    op = str(r.get("op") or "")
    # 注意: moneychg 符号不可靠 (真实买入也可能为正), 方向以 op 为准, 不做资金符号过滤
    qty = _f_pl(r.get("trans_count"))
    return {
        "account_id": str(r.get("account_id") or ""),
        "account_name": acc_name,
        "symbol": _trade_symbol(str(r.get("market_code") or ""), code),
        "name": (r.get("stock_name") or "").strip(),
        "date": date,
        "time": dt[8:14] if len(dt) >= 14 else "",
        "bs": "B" if op == "1" else ("S" if op == "2" else "?"),
        "price": _f_pl(r.get("trans_price")),
        "qty": abs(qty) if qty is not None else None,  # 卖出记录 count 为负
        "amount": _f_pl(r.get("trans_amount")),
        "fee": _f_pl(r.get("trans_fee")),
        "profit": _f_pl(r.get("profit")),
    }


def _derive_cleared(trades: list[dict]) -> list[dict]:
    """按 (账户, 代码) 重放成交: 数量归零即一轮完整清仓, 汇总成本/卖价/已实现。"""
    by_key: dict[tuple[str, str], list[dict]] = {}
    for t in trades:
        by_key.setdefault((t["account_id"], t["symbol"]), []).append(t)
    rounds: list[dict] = []
    for (acc_id, symbol), ts in by_key.items():
        qty = buy_cost = buy_qty = sell_qty = sell_amt = profit = fee = 0.0
        first_buy: str | None = None
        last_sell: str | None = None
        name = ""
        for t in sorted(ts, key=lambda x: (x["date"], x.get("time") or "")):
            name = t.get("name") or name
            q = float(t.get("qty") or 0)
            amt = float(t.get("amount") or 0)
            fee += float(t.get("fee") or 0)
            if t["bs"] == "B":
                qty += q
                buy_cost += amt
                buy_qty += q
                if first_buy is None:
                    first_buy = t["date"]
            elif t["bs"] == "S":
                qty -= q
                sell_qty += q
                sell_amt += amt
                profit += float(t.get("profit") or 0)
                last_sell = t["date"]
                if abs(qty) < 1e-6 and buy_qty > 0:
                    realized = profit if profit else sell_amt - buy_cost  # 账本 profit 恒 0 时按成本推算
                    rounds.append({
                        "account_id": acc_id, "symbol": symbol, "name": name,
                        "first_buy": first_buy, "last_sell": last_sell,
                        "qty": round(buy_qty, 4),
                        "avg_cost": round(buy_cost / buy_qty, 4) if buy_qty else None,
                        "avg_sell": round(sell_amt / sell_qty, 4) if sell_qty else None,
                        "profit": round(realized, 2), "fee": round(fee, 2),
                    })
                    qty = buy_cost = buy_qty = sell_qty = sell_amt = profit = fee = 0.0
                    first_buy = last_sell = None
    return rounds


def load_trades_cache() -> dict:
    try:
        return json.loads(_trades_path().read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def trades_status() -> dict:
    obj = load_trades_cache()
    return {
        "ok": bool(obj.get("ok")),
        "fetched_at": obj.get("fetched_at"),
        "accounts": obj.get("accounts") or [],
        "n_trades": len(obj.get("trades") or []),
        "n_cleared": len(obj.get("cleared") or []),
        "n_bank": len(obj.get("bank") or []),
    }


def fetch_trades_cache() -> dict[str, Any]:
    """逐账户拉取真实成交 (页面 POST, 全量) → 派生清仓轮次 + 出入金(best-effort)。"""
    cookie = _cdp_cookie()
    save_config(cookie=cookie)
    accounts_raw = _api("/caishen_fund/pc/account/v1/account_list", cookie, {})
    brokers = (accounts_raw.get("common") or []) + (accounts_raw.get("rzrq") or [])
    uid = _uid(cookie)

    trades: list[dict] = []
    per_acc: list[dict] = []
    bank: list[dict] = []
    for b in brokers:
        fk = str(b.get("fund_key") or "")
        if not fk:
            continue
        acc_name = (b.get("brokername") or b.get("manualname") or fk).strip()
        try:
            ex = _cdp_page_post("/caishen_fund/stock_position/v1/stock_history_query",
                                {"userid": uid, "manualid": "", "fundkey": fk,
                                 "rzrq_fundkey": "", "stock_code": "", "stock_account": "",
                                 "end_date": "", "start_date": "", "from_pc": "1"})
            raw = ex.get("list") or []
        except Exception as e:  # noqa: BLE001
            logger.warning("stock_history_query %s failed: %s", fk, e)
            raw = []
        per_acc.append({"fund_key": fk, "name": acc_name, "trades": len(raw)})
        for r in raw:
            t = _norm_trade(r, acc_name)
            if t:
                trades.append(t)
        # 出入金 (可能为空/接口变化, 失败不阻塞)
        try:
            ex = _cdp_page_post("/caishen_fund/pc/asset/v1/query_bank_history",
                                {"userid": uid, "fundkey": fk, "type": "common",
                                 "from_pc": "1"})
            for r in (ex.get("stock") or []):
                r["_account"] = acc_name
                bank.append(r)
        except Exception as e:  # noqa: BLE001
            logger.warning("query_bank_history %s failed: %s", fk, e)

    trades.sort(key=lambda t: (t["date"], t.get("time") or ""))
    cleared = _derive_cleared(trades)
    # 派生清仓轮次补账户名 (核对时与本地账户名匹配)
    name_by_fk = {a["fund_key"]: a["name"] for a in per_acc}
    for c in cleared:
        c["account_name"] = name_by_fk.get(c.get("account_id") or "", "")
    payload = {
        "ok": any(a["trades"] > 0 for a in per_acc),
        "fetched_at": datetime.utcnow().isoformat(timespec="seconds"),
        "accounts": per_acc,
        "trades": trades,
        "cleared": cleared,
        "bank": bank,
    }
    _atomic_write_json(_trades_path(), payload)
    return {"ok": payload["ok"],
            "message": f"成交缓存成功：{len(per_acc)} 账户 {len(trades)} 笔成交，派生清仓 {len(cleared)} 轮"}


def _trades_stale(max_hours: float = 12.0) -> bool:
    obj = load_trades_cache()
    fa = str(obj.get("fetched_at") or "")
    if not fa:
        return True
    try:
        dt = datetime.fromisoformat(fa)
        return (datetime.utcnow() - dt).total_seconds() > max_hours * 3600
    except Exception:  # noqa: BLE001
        return True


# ---------------------------------------------------------------- 后台任务状态

_JOBS: dict[str, dict] = {}


def _job_run(key: str, label: str, fn) -> dict:
    """后台线程执行 fn, 状态记入 _JOBS[key]; 同名任务运行中则拒绝重复启动。"""
    import threading

    st = _JOBS.setdefault(key, {"key": key, "label": label})
    if st.get("status") == "running":
        return {"started": False, **_job_state(st)}
    st.update({"status": "running", "label": label, "ok": None, "message": "拉取中…",
               "started_at": datetime.utcnow().isoformat(timespec="seconds"),
               "finished_at": None})

    def _wrap():
        try:
            res = fn()
            st.update({"status": "done", "ok": bool(res.get("ok", True)) if isinstance(res, dict) else True,
                       "message": str(res.get("message") or "完成") if isinstance(res, dict) else "完成",
                       "finished_at": datetime.utcnow().isoformat(timespec="seconds")})
        except Exception as e:  # noqa: BLE001
            st.update({"status": "done", "ok": False, "message": f"失败: {e}",
                       "finished_at": datetime.utcnow().isoformat(timespec="seconds")})

    threading.Thread(target=_wrap, daemon=True).start()
    return {"started": True, **_job_state(st)}


def _job_state(st: dict) -> dict:
    return {k: st.get(k) for k in ("key", "label", "status", "ok", "message", "started_at", "finished_at")}


def job_states() -> list[dict]:
    return [_job_state(st) for st in _JOBS.values()]


# ---------------------------------------------------------------- 港股通交收推算

_TD_CACHE: dict[str, dict] = {}


def trading_day_info(date_iso: str) -> dict | None:
    """指定日期的两地交易日信息 (账本 last_trading_day 接口, 进程内缓存)。"""
    if date_iso in _TD_CACHE:
        return _TD_CACHE[date_iso]
    cookie = _cdp_cookie()
    try:
        ex = _api("/caishen_fund/stock_common/v1/last_trading_day", cookie, {"date": date_iso})
    except Exception as e:  # noqa: BLE001
        logger.warning("trading_day_info %s failed: %s", date_iso, e)
        return None
    info = {
        "cn": bool(int(ex.get("is_trading_day") or 0)),
        "hk": bool(int(ex.get("is_hk_trading_day") or 0)),
        "next_cn": ex.get("next_trading_day"),
        "next_hk": ex.get("next_hk_trading_day"),
    }
    _TD_CACHE[date_iso] = info
    return info


def settle_date_after(sell_date: str, n: int = 2, market: str = "cn") -> str | None:
    """港股通卖出资金到账日: 卖出日后第 n 个交易日 (T+n 交收)。

    人民币资金按 A 股日历交收 (market="cn"), 节假日顺延; 接口不可用时退化为跳过周末。
    """
    from datetime import date as _date, timedelta

    try:
        d = _date.fromisoformat(sell_date)
    except ValueError:
        return None
    seen = 0
    for i in range(1, 45):
        cand = (d + timedelta(days=i))
        info = trading_day_info(cand.isoformat())
        ok = info[market] if info else cand.weekday() < 5
        if not ok:
            continue
        seen += 1
        if seen >= n:
            return cand.isoformat()
    return None


def ledger_sell_date(account_name: str | None, symbol: str) -> str | None:
    """从成交缓存派生的清仓轮次中查该 (账户, 股票) 最近一次清仓卖出日。"""
    obj = load_trades_cache()
    best = None
    for c in obj.get("cleared") or []:
        if account_name and c.get("account_name") != account_name:
            continue
        if c.get("symbol") == symbol and c.get("last_sell"):
            if best is None or c["last_sell"] > best:
                best = c["last_sell"]
    return best


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

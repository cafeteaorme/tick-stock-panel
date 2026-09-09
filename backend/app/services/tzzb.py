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
    cfg = load_config()
    cfg.update(updates)
    _store_path().write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
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
                _synced_marker = marker
                res = sync()
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
    if market in ("15", "176", "177", "178", "179", "180", "181", "182", "183"):
        return ".HK"
    if market == "2" or (len(code) == 6 and code.startswith(("5", "6", "9"))):
        return ".SH"
    if market == "1" or (len(code) == 6 and code.startswith(("0", "3"))):
        return ".SZ"
    if market in ("12", "144"):
        return ".BJ"
    return ".SH" if len(code) == 6 and code[0] in "569" else ".SZ"


def reset_tzzb(holdings_svc) -> dict[str, Any]:
    """重置投资账本对接: 清除 Cookie 配置 + 删除由账本同步生成的全部账户 (含持仓/快照/资金)。

    同步生成的账户以其 name 与账本 brokername 一致来识别 (见 sync 中创建逻辑)。
    返回删除说明。
    """
    cfg = load_config()
    accounts_raw = None
    removed = []
    cookie = (cfg.get("cookie") or "").strip()
    if cookie:
        try:
            accounts_raw = _api("/caishen_fund/pc/account/v1/account_list", cookie, {})
        except Exception:  # noqa: BLE001
            accounts_raw = None
    broker_names = []
    if accounts_raw:
        for b in (accounts_raw.get("common") or []) + (accounts_raw.get("rzrq") or []):
            nm = (b.get("brokername") or b.get("manualname") or "").strip()
            if nm:
                broker_names.append(nm)

    acc_obj = holdings_svc.list_accounts()
    keep, drop = [], []
    for a in acc_obj["accounts"]:
        # default 始终保留; 同步生成的账户 (名称命中账本 brokername) 删除
        (drop if (a["id"] != holdings_svc.DEFAULT_ACCOUNT and a["name"] in broker_names) else keep).append(a)
    for a in drop:
        holdings_svc.delete_account(a["id"])
        removed.append(a["name"])

    _store_path().write_text(json.dumps({
        "cookie": "", "endpoint": "", "user_name": "", "last_sync": None,
        "last_result": "已重置", "last_ok": False,
    }, ensure_ascii=False, indent=2), "utf-8")
    save_config(**{
        "cookie": "", "endpoint": "", "user_name": "", "last_sync": None,
        "last_result": "已重置", "last_ok": False,
    })
    return {"removed_accounts": removed, "cookie_cleared": True}


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
        acc_obj = holdings_svc.list_accounts()
        acc_id = next((a["id"] for a in acc_obj["accounts"] if a["name"] == raw_name), None)
        if acc_id is None:
            acc = holdings_svc.create_account(raw_name)
            acc_id = acc["id"]

        pos_raw = _api("/caishen_fund/pc/asset/v1/stock_position", cookie,
                       {"fund_key": fund_key, "type": "common"})
        positions = pos_raw.get("position") or []
        cash = float(pos_raw.get("money_remain") or 0)

        def _f(v):
            try:
                return float(v)
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
            holdings_svc.upsert(acc_id, symbol, qty, qty, cost, extras)
            if symbol not in {r["symbol"] for r in wl.list_symbols()}:
                wl.add(symbol)
            holdings_rows.append({"symbol": symbol, "qty": qty, "available": qty,
                                  "avg_cost": cost or None})
        holdings_svc.set_portfolio(acc_id, cash=cash)
        holdings_svc.save_snapshot(acc_id, today, cash=cash)
        synced_accounts.append({"name": raw_name, "account_id": acc_id,
                                "positions": len(holdings_rows), "cash": cash})
        total_positions += len(holdings_rows)

    save_config(last_sync=datetime.utcnow().isoformat(timespec="seconds"),
                last_result=f"同步 {len(synced_accounts)} 账户 {total_positions} 条持仓", last_ok=True)
    return {"ok": True, "message": f"同步成功：{len(synced_accounts)} 个账户，共 {total_positions} 条持仓",
            "accounts": synced_accounts}

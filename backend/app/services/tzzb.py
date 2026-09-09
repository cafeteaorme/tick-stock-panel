"""同花顺投资账本 (tzzb.10jqka.com.cn) 同步。

页面为登录制 JS 应用, 无公开 API。本模块持久化用户提供的登录 Cookie,
并用其探测账本数据接口; 探测成功后可拉取账户名/持仓, 落地为本地账户与快照。

Cookie 获取方式: 浏览器登录 tzzb.10jqka.com.cn → F12 → Network → 任意请求
→ 复制 Request Headers 里整段 Cookie 粘贴到设置。
接口为非官方形态, 可能随同花顺改版失效——同步失败时刷新/重贴 Cookie。
"""
from __future__ import annotations

import ipaddress
import json
import logging
import re
import socket
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
    "/api/v1/stock/positions",
    "/api/positions",
    "/api/stock/positions",
    "/api/v1/accounts",
    "/api/accounts",
    "/api/user/info",
    "/api/v1/user/info",
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


def _get(url: str, cookie: str) -> tuple[int, str]:
    _assert_safe(url)
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA,
        "Cookie": cookie,
        "Referer": f"https://{_ALLOWED_HOST}/",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/plain, */*",
    })
    opener = urllib.request.build_opener(_NoRedirect)
    with opener.open(req, timeout=_TIMEOUT) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


def probe_endpoints(cookie: str) -> tuple[str | None, str]:
    """依次探测候选端点, 返回 (命中的端点, 说明)。"""
    for ep in _CANDIDATE_ENDPOINTS:
        url = f"https://{_ALLOWED_HOST}{ep}"
        try:
            status, body = _get(url, cookie)
        except Exception as e:  # noqa: BLE001
            logger.debug("probe %s err: %s", ep, e)
            continue
        if status == 200 and body.strip().startswith("{"):
            try:
                obj = json.loads(body)
                # 简单判定: JSON 且非登录跳转
                if isinstance(obj, dict) and not any(k in obj for k in ("login", "redirect")):
                    return ep, body[:2000]
            except Exception:  # noqa: BLE001
                continue
        elif status in (301, 302, 401, 403):
            continue
    return None, "未探测到可用数据接口 (可能需要配合浏览器抓包更新端点列表)"


def sync(account_id: str | None = None) -> dict[str, Any]:
    """执行同步: 探测接口 → 拉账户名/持仓 → 写入本地账户。

    任何失败都以 {ok: False, message} 返回, 交由前端 toast。
    """
    from app.services import holdings as holdings_svc

    cfg = load_config()
    cookie = (cfg.get("cookie") or "").strip()
    if not cookie:
        return {"ok": False, "message": "尚未配置投资账本 Cookie：浏览器登录 tzzb.10jqka.com.cn 后，在 F12 Network 里复制整段 Cookie 粘贴到持仓设置"}

    endpoint = cfg.get("endpoint") or ""
    body = ""
    if endpoint:
        try:
            _, body = _get(f"https://{_ALLOWED_HOST}{endpoint}", cookie)
        except Exception as e:  # noqa: BLE001
            logger.warning("tzzb cached endpoint failed: %s", e)
            endpoint, body = "", ""
    if not endpoint or not body:
        endpoint, probe_body = probe_endpoints(cookie)
        body = probe_body
        if not endpoint:
            save_config(last_sync=datetime.utcnow().isoformat(timespec="seconds"),
                        last_result="未探测到可用接口")
            return {"ok": False, "message": "同步失败：未探测到投资账本数据接口（页面为登录制且无公开 API）。请配合浏览器抓包提供接口路径，或继续使用截图导入"}
        save_config(endpoint=endpoint)

    # 解析返回: 提取账户名与持仓 (尽力而为, 字段形态未知 → 宽容匹配)
    try:
        obj = json.loads(body)
    except Exception:  # noqa: BLE001
        obj = {}
    flattened = json.dumps(obj, ensure_ascii=False)

    user_name = cfg.get("user_name") or ""
    name_m = re.search(r'"(?:name|nickname|user_?name)"\s*:\s*"([^"]{1,24})"', flattened)
    if name_m:
        user_name = name_m.group(1)

    # 持仓: 宽容提取 code/name/qty/cost
    rows = []
    for m in re.finditer(r'\{[^{}]*"code"\s*:\s*"(\d{4,6}|[A-Z.]{1,8})"[^{}]*\}', flattened):
        seg = m.group(0)
        def _g(key: str) -> Any:
            mm = re.search(rf'"{key}"\s*:\s*("?[^,"}}]+"?)', seg)
            return mm.group(1).strip('"') if mm else None
        rows.append({"code": m.group(1), "name": _g("name"), "qty": _g("qty"), "cost": _g("cost")})

    # 命中/落地
    acc = account_id or holdings_svc.DEFAULT_ACCOUNT
    imported = 0
    if rows:
        for r in rows:
            imported += 1 if r.get("qty") else 0

    save_config(last_sync=datetime.utcnow().isoformat(timespec="seconds"),
                user_name=user_name,
                last_result=f"接口 {endpoint} · 解析 {len(rows)} 条持仓")
    return {
        "ok": True,
        "message": f"同步成功：接口 {endpoint}，账户「{user_name or '未知名'}」，解析 {len(rows)} 条持仓记录",
        "endpoint": endpoint,
        "user_name": user_name,
        "rows_hint": rows[:50],
        "imported": imported,
    }

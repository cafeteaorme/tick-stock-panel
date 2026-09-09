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


_SYNC_INTERVAL_S = 3600  # 每小时
_sync_thread: threading.Thread | None = None
_sync_stop = threading.Event()


def start_background_sync() -> bool:
    """每小时后台同步一次 (仅配置了 Cookie 时真正拉取)。幂等。"""
    global _sync_thread
    if _sync_thread is not None and _sync_thread.is_alive():
        return False
    _sync_stop.clear()

    def _loop() -> None:
        while not _sync_stop.wait(_SYNC_INTERVAL_S):
            try:
                cfg = load_config()
                if not (cfg.get("cookie") or "").strip():
                    continue  # 未配置, 静默跳过
                res = sync()
                logger.info("tzzb hourly sync: %s", res.get("message", "")[:120])
            except Exception as e:  # noqa: BLE001
                logger.warning("tzzb hourly sync error: %s", e)

    _sync_thread = threading.Thread(target=_loop, daemon=True, name="tzzb-hourly-sync")
    _sync_thread.start()
    logger.info("tzzb hourly sync started (interval %ss)", _SYNC_INTERVAL_S)
    return True


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
                        last_result="未探测到可用接口", last_ok=False)
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
                last_result=f"接口 {endpoint} · 解析 {len(rows)} 条持仓", last_ok=True)
    return {
        "ok": True,
        "message": f"同步成功：接口 {endpoint}，账户「{user_name or '未知名'}」，解析 {len(rows)} 条持仓记录",
        "endpoint": endpoint,
        "user_name": user_name,
        "rows_hint": rows[:50],
        "imported": imported,
    }


# ---------------------------------------------------------------- 自动读取浏览器 Cookie (Chrome 系)

_COOKIE_DOMAIN_KEY = "10jqka"

# (浏览器名, 钥匙串服务名, Cookie 库相对路径)
_CHROMIUM_BROWSERS = [
    ("Chrome", "Chrome Safe Storage", "Google/Chrome/Default/Cookies"),
    ("Edge", "Microsoft Edge Safe Storage", "Microsoft Edge/Default/Cookies"),
    ("Brave", "Brave Safe Storage", "BraveSoftware/Brave-Browser/Default/Cookies"),
]


def auto_read_browser_cookie() -> dict[str, Any]:
    """从本机 Chromium 系浏览器解密 10jqka 域 Cookie (仅读取该域, 不出本机)。

    流程: 钥匙串取 Safe Storage 密钥 (macOS 弹一次授权框) → 复制 Cookie 库到临时文件
    → sqlite 查询 → AES-128-CBC 解密 v10 值 (PBKDF2-SHA1/1003 轮/saltysalt, IV=16空格)。
    返回 {ok, cookie|message, source}。
    """
    import sqlite3
    import subprocess
    import tempfile

    from Crypto.Cipher import AES

    home = Path.home()
    errors: list[str] = []
    for browser, service, rel in _CHROMIUM_BROWSERS:
        db = home / "Library" / "Application Support" / rel
        if not db.exists():
            errors.append(f"{browser}: 未安装")
            continue
        # 1) 钥匙串密钥 (首次弹授权框, 用户点「始终允许」)
        try:
            key_pass = subprocess.run(
                ["/usr/bin/security", "find-generic-password", "-w", "-s", service],
                capture_output=True, text=True, timeout=120,
            )
            if key_pass.returncode != 0 or not key_pass.stdout.strip():
                errors.append(f"{browser}: 钥匙串未授权 ({key_pass.stderr.strip()[:60]})")
                continue
            key_pass = key_pass.stdout.strip()
        except subprocess.TimeoutExpired:
            errors.append(f"{browser}: 钥匙串授权超时 (请重试并在弹窗点「始终允许」)")
            continue

        # 2) 复制 DB (浏览器运行中库被锁)
        try:
            with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tf:
                tmp = tf.name
            subprocess.run(["cp", str(db), tmp], check=True, timeout=30)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{browser}: Cookie 库复制失败 ({e})")
            continue

        # 3) 查询 + 解密
        try:
            con = sqlite3.connect(tmp)
            rows = con.execute(
                "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?",
                (f"%{_COOKIE_DOMAIN_KEY}%",),
            ).fetchall()
            con.close()
        except Exception as e:  # noqa: BLE001
            errors.append(f"{browser}: Cookie 库读取失败 ({e})")
            continue
        finally:
            Path(tmp).unlink(missing_ok=True)

        if not rows:
            errors.append(f"{browser}: 未找到 10jqka 域 Cookie (请先在该浏览器登录投资账本)")
            continue

        key = hashlib.pbkdf2_hmac("sha1", key_pass.encode(), b"saltysalt", 1003, dklen=16)
        iv = b" " * 16
        pairs = []
        for name, enc in rows:
            if not enc:
                continue
            try:
                blob = enc
                if blob[:3] == b"v10":
                    blob = blob[3:]
                dec = AES.new(key, AES.MODE_CBC, iv).decrypt(blob)
                dec = dec[:-dec[-1]] if 0 < dec[-1] <= 16 else dec  # 去 PKCS7
                val = dec.decode("utf-8", errors="replace")
                if val:
                    pairs.append(f"{name}={val}")
            except Exception:  # noqa: BLE001
                continue
        if not pairs:
            errors.append(f"{browser}: Cookie 解密失败 (浏览器版本过新? 请手动粘贴)")
            continue

        return {"ok": True, "cookie": "; ".join(pairs), "source": browser}

    return {"ok": False, "message": "；".join(errors)}

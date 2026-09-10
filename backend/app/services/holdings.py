"""我的持仓服务 (多账户)。

存储布局:
- user_data/holdings/accounts.json : {accounts:[{id,name,created_at}], active:"<id>"}
- user_data/holdings/<account_id>/holdings.parquet : symbol, qty, available, avg_cost, opened_at, status, closed_at, realized_pnl
- user_data/holdings/<account_id>/portfolio.json   : {initial_cap, cash, withdrawals, updated_at}
- user_data/holdings/<account_id>/snapshots/*.json : 历史快照

旧版单账户文件 (user_data/holdings.parquet 等) 首次访问时自动迁移到 default 账户。
"""
from __future__ import annotations

import json
import logging
import shutil
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
    # 投资账本同步的富字段
    "price": pl.Float64,
    "change_pct": pl.Float64,
    "source": pl.Utf8,
    "hold_days": pl.Float64,
    "position_rate": pl.Float64,
    "pre_profit": pl.Float64,
    "pre_rate": pl.Float64,
    "hold_profit": pl.Float64,
    "hold_rate": pl.Float64,
    "m1_rate": pl.Float64,
    "m3_rate": pl.Float64,
    "m6_rate": pl.Float64,
    "m12_rate": pl.Float64,
}

DEFAULT_ACCOUNT = "default"


# ---------------------------------------------------------------- 账户


def _base_dir() -> Path:
    return settings.data_dir / "user_data" / "holdings"


def _accounts_path() -> Path:
    p = _base_dir() / "accounts.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _migrate_legacy() -> None:
    """旧单账户文件 → default 账户目录 (一次性)。直接拼路径, 不经 _acc_dir 避免互递归。"""
    acc_dir = _base_dir() / DEFAULT_ACCOUNT
    if acc_dir.exists():
        return
    legacy = settings.data_dir / "user_data"
    moved = False
    acc_dir.mkdir(parents=True, exist_ok=True)
    for name, target in (
        ("holdings.parquet", "holdings.parquet"),
        ("portfolio.json", "portfolio.json"),
    ):
        src = legacy / name
        if src.exists():
            shutil.move(str(src), str(acc_dir / target))
            moved = True
    legacy_snaps = legacy / "holdings_snapshots"
    if legacy_snaps.is_dir():
        shutil.move(str(legacy_snaps), str(acc_dir / "snapshots"))
        moved = True
    if moved:
        logger.info("legacy holdings migrated to account '%s'", DEFAULT_ACCOUNT)


def _acc_dir(account_id: str) -> Path:
    _migrate_legacy()
    p = _base_dir() / account_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _atomic_write(path: Path, data: str) -> None:
    """原子写: 临时文件 + os.replace, 避免进程被杀导致文件截断损坏。"""
    import os
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, "utf-8")
    os.replace(tmp, path)


def list_accounts() -> dict[str, Any]:
    path = _accounts_path()
    obj: dict[str, Any] | None = None
    try:
        parsed = json.loads(path.read_text("utf-8"))
        if parsed.get("accounts"):
            obj = parsed
    except Exception:  # noqa: BLE001
        obj = None
    if obj is None:
        # 损坏/缺失 → 从磁盘上现存账户目录重建 (目录名即账户 id)
        rebuilt = []
        base = _base_dir()
        base.mkdir(parents=True, exist_ok=True)
        for d in sorted(base.iterdir()):
            if d.name == DEFAULT_ACCOUNT and d.is_dir():
                rebuilt.insert(0, {"id": d.name, "name": "默认账户",
                                   "created_at": datetime.utcnow().isoformat(timespec="seconds")})
            elif d.is_dir() and (d / "holdings.parquet").exists():
                rebuilt.append({"id": d.name, "name": f"账户 {d.name[-4:]}",
                                "created_at": datetime.utcnow().isoformat(timespec="seconds")})
        obj = {"accounts": rebuilt or [{"id": DEFAULT_ACCOUNT, "name": "默认账户",
                                        "created_at": datetime.utcnow().isoformat(timespec="seconds")}],
               "active": (rebuilt or [DEFAULT_ACCOUNT])[0] if rebuilt else DEFAULT_ACCOUNT}
        obj["active"] = obj["accounts"][0]["id"] if obj["accounts"] else DEFAULT_ACCOUNT
        save_accounts(obj)
    if obj.get("active") not in {a["id"] for a in obj["accounts"]}:
        obj["active"] = obj["accounts"][0]["id"] if obj["accounts"] else DEFAULT_ACCOUNT
    return obj


def save_accounts(obj: dict[str, Any]) -> None:
    _atomic_write(_accounts_path(), json.dumps(obj, ensure_ascii=False, indent=2))


def resolve_account(account_id: str | None) -> str:
    """显式指定优先; 否则 active。未知 id 回退 default。"""
    obj = list_accounts()
    ids = {a["id"] for a in obj["accounts"]}
    if account_id and account_id in ids:
        return account_id
    if obj.get("active") in ids:
        return obj["active"]
    return DEFAULT_ACCOUNT


def find_account_by_name(name: str) -> str | None:
    obj = list_accounts()
    for a in obj["accounts"]:
        if a["name"] == name:
            return a["id"]
    return None


def create_account(name: str) -> dict[str, Any]:
    # 同名账户复用同一 id (投资账本同步按名称落地, 避免反复同步产生重复账户)
    existing = find_account_by_name(name)
    if existing:
        return {"id": existing, "name": name, "created_at": ""}
    obj = list_accounts()
    account_id = f"acc_{int(datetime.utcnow().timestamp() * 1000)}"
    acc = {"id": account_id, "name": name or f"账户{len(obj['accounts']) + 1}",
           "created_at": datetime.utcnow().isoformat(timespec="seconds")}
    obj["accounts"].append(acc)
    obj["active"] = account_id
    save_accounts(obj)
    _acc_dir(account_id)
    return acc


def rename_account(account_id: str, name: str) -> dict[str, Any]:
    obj = list_accounts()
    for a in obj["accounts"]:
        if a["id"] == account_id:
            a["name"] = name
    save_accounts(obj)
    return obj


def delete_account(account_id: str) -> dict[str, Any]:
    if account_id == DEFAULT_ACCOUNT:
        raise ValueError("默认账户不可删除")
    obj = list_accounts()
    obj["accounts"] = [a for a in obj["accounts"] if a["id"] != account_id]
    if obj.get("active") == account_id:
        obj["active"] = obj["accounts"][0]["id"] if obj["accounts"] else DEFAULT_ACCOUNT
    save_accounts(obj)
    d = _base_dir() / account_id
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
    return obj


def set_active_account(account_id: str) -> dict[str, Any]:
    obj = list_accounts()
    if account_id in {a["id"] for a in obj["accounts"]}:
        obj["active"] = account_id
        save_accounts(obj)
    return obj


# ---------------------------------------------------------------- 持仓 CRUD


def _schema_path(account_id: str) -> Path:
    return _acc_dir(account_id) / "holdings.parquet"


def _read(account_id: str) -> pl.DataFrame:
    p = _schema_path(account_id)
    if not p.exists():
        return pl.DataFrame(schema=_SCHEMA)
    df = pl.read_parquet(p)
    for col, dtype in _SCHEMA.items():
        if col not in df.columns:
            df = df.with_columns(pl.lit(None, dtype=dtype).alias(col))
    return df


def _write(account_id: str, df: pl.DataFrame) -> None:
    df.write_parquet(_schema_path(account_id))


def list_all(account_id: str, include_closed: bool = False) -> list[dict[str, Any]]:
    df = _read(account_id)
    if df.is_empty():
        return []
    if not include_closed:
        df = df.filter(pl.col("status") != "closed")
    return df.sort("symbol").to_dicts()


def get(account_id: str, symbol: str) -> dict[str, Any] | None:
    df = _read(account_id)
    hit = df.filter((pl.col("symbol") == symbol) & (pl.col("status") != "closed"))
    return hit.to_dicts()[0] if not hit.is_empty() else None


def upsert(account_id: str, symbol: str, qty: float,
           available: float | None = None, avg_cost: float | None = None,
           extras: dict | None = None, source: str = "tzzb") -> list[dict]:
    df = _read(account_id)
    row = {
        "symbol": symbol,
        "qty": float(qty),
        "available": float(available if available is not None else qty),
        "avg_cost": float(avg_cost) if avg_cost is not None else None,
        "opened_at": datetime.utcnow().isoformat(timespec="seconds"),
        "status": "open",
        "closed_at": None,
        "realized_pnl": None,
        "source": source,
    }
    for k, v in (extras or {}).items():
        # extras 可覆盖默认值 (尤其 status/closed_at: 账本报 qty=0 且本地无持仓 → 直接落为已清仓行)
        if k in _SCHEMA:
            row[k] = v
    if row["status"] == "closed":
        # 清仓行: 同股旧 closed 行直接替换 (否则每次同步叠加一条), 顺带清掉残留 open 行
        df = df.filter(pl.col("symbol") != symbol)
    else:
        # open 行: 只替换同股 open 行, 保留历史 closed 轮次
        df = df.filter(~((pl.col("symbol") == symbol) & (pl.col("status") != "closed")))
    out = pl.concat([pl.DataFrame([row], schema=_SCHEMA), df], how="diagonal_relaxed")
    _write(account_id, out)
    return list_all(account_id)


def sell(account_id: str, symbol: str, price: float, qty: float | None = None) -> dict[str, Any]:
    h = get(account_id, symbol)
    if h is None:
        raise ValueError(f"{symbol} 不在持仓中")
    cost = h.get("avg_cost") or 0.0
    sell_qty = float(qty) if qty is not None else float(h["qty"])
    sell_qty = min(sell_qty, float(h["qty"]))
    realized = (float(price) - float(cost)) * sell_qty

    df = _read(account_id)
    if sell_qty >= float(h["qty"]) - 1e-9:
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
            .then(pl.min_horizontal(pl.col("available") - sell_qty, pl.lit(remain)).clip(lower_bound=0.0))
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
    _write(account_id, df)
    return {"symbol": symbol, "realized_pnl": realized}


def remove(account_id: str, symbol: str) -> list[dict]:
    df = _read(account_id).filter(pl.col("symbol") != symbol)
    _write(account_id, df)
    return list_all(account_id, include_closed=True)


def remove_stale_tzzb(account_id: str, valid_symbols: set[str]) -> list[str]:
    """同步清理: 删除不在最新账本持仓中的 tzzb 来源 open 行 (保护手动/截图来源)。"""
    df = _read(account_id)
    stale = df.filter(
        (pl.col("status") != "closed")
        & (pl.col("source") == "tzzb")
        & ~pl.col("symbol").is_in(list(valid_symbols))
    )
    names = stale["symbol"].to_list()
    if names:
        df = df.filter(
            ~((pl.col("status") != "closed") & (pl.col("source") == "tzzb")
              & pl.col("symbol").is_in(names))
        )
        _write(account_id, df)
    return names


def reset(account_id: str, include_portfolio: bool = True) -> int:
    """重置当前账户: 清空持仓与快照 (可选资金设置)。返回删除的持仓行数。"""
    df = _read(account_id)
    n = df.height
    pl.DataFrame(schema=_SCHEMA).write_parquet(_schema_path(account_id))
    snap = _acc_dir(account_id) / "snapshots"
    if snap.is_dir():
        shutil.rmtree(snap, ignore_errors=True)
    if include_portfolio:
        p = _acc_dir(account_id) / "portfolio.json"
        p.unlink(missing_ok=True)
    return n


# ---------------------------------------------------------------- 组合资金


def _portfolio_path(account_id: str) -> Path:
    return _acc_dir(account_id) / "portfolio.json"


def get_portfolio(account_id: str) -> dict[str, Any]:
    p = _portfolio_path(account_id)
    try:
        obj = json.loads(p.read_text("utf-8"))
        return {
            "initial_cap": float(obj.get("initial_cap") or 0.0),
            "cash": float(obj.get("cash") or 0.0),
            "withdrawals": float(obj.get("withdrawals") or 0.0),
            "updated_at": obj.get("updated_at"),
        }
    except Exception:  # noqa: BLE001
        return {"initial_cap": 0.0, "cash": 0.0, "withdrawals": 0.0, "updated_at": None}


def set_portfolio(account_id: str, initial_cap: float | None = None,
                  cash: float | None = None, withdrawals: float | None = None) -> dict[str, Any]:
    cur = get_portfolio(account_id)
    obj = {
        "initial_cap": float(initial_cap) if initial_cap is not None else cur["initial_cap"],
        "cash": float(cash) if cash is not None else cur["cash"],
        "withdrawals": float(withdrawals) if withdrawals is not None else cur["withdrawals"],
        "updated_at": datetime.utcnow().isoformat(timespec="seconds"),
    }
    _atomic_write(_portfolio_path(account_id), json.dumps(obj, ensure_ascii=False, indent=2))
    return obj


# ---------------------------------------------------------------- 历史快照


def _snap_dir(account_id: str) -> Path:
    p = _acc_dir(account_id) / "snapshots"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _cleanup_snapshots(account_id: str, keep: int) -> None:
    """快照保留策略: 超出 keep 份时清理最旧 (keep<=0 = 全部保留)。"""
    if keep <= 0:
        return
    snaps = sorted(_snap_dir(account_id).glob("*.json"))
    for f in snaps[:-keep] if len(snaps) > keep else []:
        f.unlink(missing_ok=True)


def snapshot_keep_limit() -> int:
    from app.services import preferences

    return preferences.get_holdings_snapshot_keep()


def save_snapshot(account_id: str, date_iso: str, rows: list[dict] | None = None, cash: float | None = None) -> dict:
    obj_rows = rows if rows is not None else list_all(account_id)
    port = get_portfolio(account_id)
    obj = {
        "date": date_iso,
        "cash": float(cash) if cash is not None else port["cash"],
        "rows": [
            {"symbol": r["symbol"], "qty": float(r.get("qty") or 0),
             "available": r.get("available"), "avg_cost": r.get("avg_cost")}
            for r in obj_rows
        ],
        "saved_at": datetime.utcnow().isoformat(timespec="seconds"),
    }
    (_snap_dir(account_id) / f"{date_iso.replace('-', '')}.json").write_text(
        json.dumps(obj, ensure_ascii=False), "utf-8"
    )
    _cleanup_snapshots(account_id, snapshot_keep_limit())
    return obj


def list_snapshots(account_id: str) -> list[dict]:
    out = []
    for f in sorted(_snap_dir(account_id).glob("*.json")):
        try:
            out.append(json.loads(f.read_text("utf-8")))
        except Exception:  # noqa: BLE001
            continue
    out.sort(key=lambda x: x["date"])
    return out


def snapshot_timeline(account_id: str) -> list[dict]:
    """分段时间线: 快照(升序) + 末尾当前持仓 (date=今天)。"""
    segs: list[dict] = [
        {"date": s["date"], "cash": float(s.get("cash") or 0), "rows": s.get("rows") or []}
        for s in list_snapshots(account_id)
    ]
    today = datetime.utcnow().date().isoformat()
    cur = list_all(account_id)
    port = get_portfolio(account_id)
    if cur:
        segs.append({
            "date": today,
            "cash": port["cash"],
            "rows": [
                {"symbol": r["symbol"], "qty": float(r.get("qty") or 0), "avg_cost": r.get("avg_cost")}
                for r in cur
            ],
        })
    dedup: dict[str, dict] = {}
    for s in segs:
        dedup[s["date"]] = s
    return [dedup[k] for k in sorted(dedup)]

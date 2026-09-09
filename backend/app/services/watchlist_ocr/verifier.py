"""stockocr (macOCR / Apple Vision) 本地扫描验证。

AI 视觉识别完成后, 用本机 stockocr 二次扫描同一张截图,
交叉验证候选的名称与数量是否在本地 OCR 文本中出现:
- 名称: 去空格归一后包含匹配
- 数量: 该行附近出现的整数
验证结果附着在候选上 (verified), 前端显示 ✓/⚠。

本机未安装 stockocr (brew install stockocr / macOCR) 时验证跳过, 不影响识别。
"""
from __future__ import annotations

import logging
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_TIMEOUT_S = 30


def stockocr_available() -> bool:
    return shutil.which("stockocr") is not None


def _run_ocr(image_bytes: bytes) -> str:
    """stockocr 文本识别 (简体中文)。失败抛异常。"""
    if not stockocr_available():
        raise RuntimeError("stockocr 未安装")
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(image_bytes)
        tmp = f.name
    try:
        proc = subprocess.run(  # noqa: S603 (固定参数, 无 shell)
            ["stockocr", "-i", tmp, "-l", "zh-Hans", "--no-copy", "--no-barcodes"],
            capture_output=True, text=True, timeout=_TIMEOUT_S,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"stockocr 退出码 {proc.returncode}: {proc.stderr[:120]}")
        return proc.stdout or ""
    finally:
        Path(tmp).unlink(missing_ok=True)


def _normalize(s: str) -> str:
    return re.sub(r"\s+", "", str(s or ""))


def verify_candidates(image_bytes: bytes, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """对候选做本地 OCR 交叉验证。返回 None = 验证不可用 (未安装/失败)。"""
    if not stockocr_available():
        return None
    try:
        text = _run_ocr(image_bytes)
    except Exception as e:  # noqa: BLE001
        logger.warning("stockocr verify failed: %s", e)
        return None
    if not text.strip():
        return None

    norm_text = _normalize(text)
    verified_count = 0
    for c in candidates:
        name = _normalize(c.get("name"))
        checks: list[bool] = []
        if name:
            checks.append(name in norm_text)
        qty = c.get("qty")
        if qty is not None and float(qty) > 0:
            # 数量以千分位或纯数字形态出现
            q = str(int(float(qty)))
            checks.append(q in norm_text or f"{int(float(qty)):,}" in norm_text)
        c["verified"] = all(checks) if checks else None  # 无可验证字段时为 None
        if c["verified"]:
            verified_count += 1

    return {
        "available": True,
        "verified_count": verified_count,
        "total": len(candidates),
    }

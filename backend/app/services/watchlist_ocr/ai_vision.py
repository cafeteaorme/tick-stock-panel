"""AI 视觉识别 Provider — 用多模态模型识别持仓截图 (支持 A股/港股/美股)。

复用设置页已配置的 openai 兼容客户端。模型解析优先级:
1. 设置项 ai_vision_model (显式指定)
2. 当前模型名含 vision → 直接用
3. /models 列表里第一个名字含 vision 的模型 (如 deepseek-v4-flash-vision-exp)
4. 找不到 → 不可用 (reason: no_vision_model)

识别要点 (实测 deepseek-v4-flash-vision-exp):
- reasoning 模型, max_tokens 必须 ≥8000 否则推理耗尽 quota 后 content 为空
- 输入用原始彩色图 (不要反相), 长边压到 ~2200px
- 输出行可能混入 <think>/markdown 围栏, 由 _clean_model_output 剥离
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
from functools import lru_cache
from io import BytesIO
from ipaddress import ip_address
from urllib.parse import urlsplit

from PIL import Image

from app.services.watchlist_ocr.provider import OcrProvider

logger = logging.getLogger(__name__)

_PROMPT = """识别这张券商持仓截图。只输出 JSON 对象 (含汇总区与持仓明细两部分):
{"summary":{"total_asset":总资产,"total_pnl":总盈亏,"day_pnl":当日参考盈亏,"day_pnl_pct":当日盈亏百分比,"market_value":总市值,"cash_available":可用,"cash_withdrawable":可取,"position_pct":仓位百分比},
 "holdings":[{"market":"CN|HK|US","code":"图中可见的代码,不可见null","name":"名称原文","qty":持仓数量,"available":可用数量,"cost":成本价}]}

说明:
- summary 各项取图中汇总区数字, 全部缺失时 summary 为 null; 百分比用小数 (-0.61% → -0.0061)
- market 按交易所/货币/代码形态判断 (6位数字=CN, 4-5位数字=HK, 字母=US)
- holdings: 数量取「持仓」列, 可用取「可用」列; cost 忽略货币符号保留全部小数位
- 某字段看不到就用 null; 已清仓 (数量 0) 的行也要输出
不要输出 JSON 以外的任何内容。"""

_DATA_LINE_RE = re.compile(r"^\s*(CN|HK|US)\s+\S+\s+\S+.*$")


def _clean_model_output(text: str) -> str:
    """剥离 <think> 推理与围栏, 提取 JSON 对象/数组; 无 JSON 时退回数据行格式。"""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<think>.*", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"```[a-z]*", "", text, flags=re.IGNORECASE)
    # 优先找对象 {"summary":...}; 否则找数组 (旧行格式兜底)
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start = text.find(open_ch)
        end = text.rfind(close_ch)
        if start != -1 and end > start:
            candidate = text[start : end + 1].strip()
            try:
                import json as _json

                parsed = _json.loads(candidate)
                if isinstance(parsed, (dict, list)):
                    return candidate
            except Exception:  # noqa: BLE001
                continue
    lines = [ln.strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if _DATA_LINE_RE.match(ln))


def _validate_base_url_https_public() -> None:
    """安全校验: AI 视觉通道仅允许 https 且禁止内网/环回地址。"""
    from app import secrets_store
    from app.config import settings
    from app.services.ai_provider import normalize_openai_base_url

    raw = secrets_store.get_ai_config("ai_base_url", settings.ai_base_url)
    url = normalize_openai_base_url(raw)
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise RuntimeError(f"AI 视觉识别要求 https 的 API 地址 (当前: {parts.scheme})")
    host = (parts.hostname or "").strip()
    if not host:
        raise RuntimeError("AI API 地址无效")
    try:
        ip = ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
            raise RuntimeError("AI 视觉识别不允许访问内网/环回地址")
    except ValueError:
        if host.lower() in ("localhost",) or host.lower().endswith(".local") or host.lower().endswith(".internal"):
            raise RuntimeError("AI 视觉识别不允许访问内网地址")


@lru_cache(maxsize=1)
def _resolve_vision_model_cached() -> str:
    """探测可用的视觉模型 (进程内缓存一次)。返回 '' 表示没有。"""
    from app import secrets_store
    from app.config import settings
    from app.services.ai_provider import _openai_client, current_ai_model, normalize_openai_base_url

    explicit = secrets_store.get_ai_config("ai_vision_model", "")
    if explicit:
        return explicit
    cur = current_ai_model()
    if "vision" in cur.lower():
        return cur
    try:
        client = _openai_client(secrets_store.get_ai_key(), 20.0)

        async def _probe() -> list[str]:
            page = await client.models.list()
            return [m.id for m in page.data]

        import asyncio

        for mid in asyncio.run(_probe()):
            if "vision" in mid.lower():
                return mid
    except Exception as e:  # noqa: BLE001
        logger.warning("vision model probe failed: %s", e)
    _ = normalize_openai_base_url  # keep import meaningful for linters
    return ""


def resolve_vision_model() -> str:
    try:
        return _resolve_vision_model_cached()
    except Exception:  # noqa: BLE001
        return ""


def reset_vision_model_cache() -> None:
    _resolve_vision_model_cached.cache_clear()


def _prep_image(image_bytes: bytes, max_edge: int = 2200) -> Image.Image:
    """AI 视觉输入预处理: 原始彩色, 只限长边 (不做反相/灰度 — 视觉模型原生处理暗色主题)。"""
    img = Image.open(BytesIO(image_bytes))
    if pixels := img.width * img.height:
        if pixels > 12_000_000:
            raise ValueError("图片分辨率过高,请裁剪后重试")
    img.load()
    img = img.convert("RGB")
    if max(img.size) > max_edge:
        img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    return img


class AiVisionOcrProvider(OcrProvider):
    """多模态模型识别截图 → 转成 pipeline 可解析的文本行。"""

    name = "ai_vision"

    def available(self) -> bool:
        try:
            from app.services.ai_provider import ai_configured, is_codex_cli_provider

            if is_codex_cli_provider():
                return False
            return bool(ai_configured() and resolve_vision_model())
        except Exception:  # noqa: BLE001
            return False

    def unavailable_reason(self) -> str:
        from app.services.ai_provider import ai_configured

        if not ai_configured():
            return "AI 未配置"
        if not resolve_vision_model():
            return "未找到视觉模型 (模型名需含 vision, 或在 AI 设置加 ai_vision_model)"
        return ""

    def extract_text(self, image_bytes: bytes) -> str:
        # import-image 端点已在 worker 线程中调用本方法, 线程内无事件循环
        return asyncio.run(self._extract_async(image_bytes))

    async def _extract_async(self, image_bytes: bytes) -> str:
        from app import secrets_store
        from app.services.ai_provider import _openai_client

        _validate_base_url_https_public()
        model = resolve_vision_model()
        if not model:
            raise RuntimeError("未找到可用的视觉模型 (当前模型不支持图片, 且模型列表中无 vision 模型)")
        ai_key = secrets_store.get_ai_key()
        if not ai_key:
            raise RuntimeError("AI API Key 未配置, 请在设置页配置")

        img = _prep_image(image_bytes)
        buf = BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        client = _openai_client(ai_key, 240.0)
        # reasoning 模型偶发把 token 耗尽在思考上 (content 为空) → 最多重试 2 次
        last_err = "视觉模型未返回识别结果"
        for attempt in range(2):
            resp = await client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": _PROMPT},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                        ],
                    }
                ],
                max_tokens=8000,
            )
            text = (resp.choices[0].message.content or "").strip() if resp.choices else ""
            cleaned = _clean_model_output(text)
            if cleaned:
                return cleaned
            finish = resp.choices[0].finish_reason if resp.choices else None
            last_err = f"{last_err} (finish={finish})"
            logger.warning("ai_vision attempt %d empty (finish=%s), retrying", attempt + 1, finish)
        raise RuntimeError(f"{last_err}。可重试一次, 或换更清晰的截图。")


_provider_instance: AiVisionOcrProvider | None = None


def get_ai_vision_provider() -> AiVisionOcrProvider:
    global _provider_instance
    if _provider_instance is None:
        _provider_instance = AiVisionOcrProvider()
    return _provider_instance

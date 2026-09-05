"""AI 视觉识别 Provider — 用多模态模型识别持仓截图 (支持 A股/港股/美股)。

复用设置页已配置的 openai 兼容客户端 (base_url / api_key / model)。
识别结果转成与 Tesseract 相同的「文本行」形态, 交由 pipeline 统一解析:
每行输出 `市场 代码 名称 数量 成本价`, 港股 4-5 位码与美股字母码
由字典校验, 与 Tesseract 通道共用一套下游逻辑。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
from ipaddress import ip_address
from urllib.parse import urlsplit

from app.services.watchlist_ocr.provider import OcrProvider, preprocess_for_ocr

logger = logging.getLogger(__name__)

_PROMPT = """你是券商持仓截图识别器。逐行读出图中每一条持仓记录。

输出格式 (每行一条, 用空格分隔, 不要输出任何其他内容、不要思考过程、不要 markdown):
市场 代码 名称 数量 成本价

- 市场: CN(A股) / HK(港股) / US(美股)。按交易所/货币/代码形态判断 (6位数字=CN, 4-5位数字=HK, 字母=US)。
- 代码: 图中可见则原样照抄; 图中不显示代码则输出 -
- 名称: 必填, 保留图中原文 (如 长鑫科技、MINIMAX-W)
- 数量: 持仓股数纯数字, 没有则输出 -
- 成本价: 成本/买入价纯数字, 没有则输出 -
只输出图里确凿可见的持仓行, 不要编造, 不要输出表头。"""

# 只保留符合「市场 代码 名称 …」格式的数据行, 防止模型思考文本混入下游解析
_DATA_LINE_RE = re.compile(r"^\s*(CN|HK|US)\s+\S+\s+\S+.*$")


def _clean_model_output(text: str) -> str:
    """剥离 <think> 推理与 markdown 围栏, 只保留符合数据行格式的行。"""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<think>.*", "", text, flags=re.DOTALL | re.IGNORECASE)  # 未闭合的 think 块
    text = re.sub(r"^```[a-z]*\s*|\s*```$", "", text, flags=re.MULTILINE)
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
    # 域名形态才放行内网域名检查; IP 形态直接判网段
    try:
        ip = ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
            raise RuntimeError("AI 视觉识别不允许访问内网/环回地址")
    except ValueError:
        # 域名: 拒绝明显的内网后缀
        if host.lower() in ("localhost",) or host.lower().endswith(".local") or host.lower().endswith(".internal"):
            raise RuntimeError("AI 视觉识别不允许访问内网地址")


class AiVisionOcrProvider(OcrProvider):
    """多模态模型识别截图 → 转成 pipeline 可解析的文本行。"""

    name = "ai_vision"

    def available(self) -> bool:
        try:
            from app.services.ai_provider import ai_configured, current_ai_provider, is_codex_cli_provider

            if is_codex_cli_provider():
                return False  # codex CLI 通道不支持图片输入
            return ai_configured()
        except Exception:  # noqa: BLE001
            return False

    def extract_text(self, image_bytes: bytes) -> str:
        # import-image 端点已在 worker 线程中调用本方法 (anyio.to_thread), 线程内无事件循环
        return asyncio.run(self._extract_async(image_bytes))

    async def _extract_async(self, image_bytes: bytes) -> str:
        from app import secrets_store
        from app.services.ai_provider import _openai_client, current_ai_model

        _validate_base_url_https_public()
        ai_key = secrets_store.get_ai_key()
        if not ai_key:
            raise RuntimeError("AI API Key 未配置, 请在设置页配置")

        img = preprocess_for_ocr(image_bytes)
        from io import BytesIO

        buf = BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        client = _openai_client(ai_key, 180.0)
        resp = await client.chat.completions.create(
            model=current_ai_model(),
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ],
                }
            ],
            max_tokens=2000,
        )
        text = (resp.choices[0].message.content or "").strip() if resp.choices else ""
        return _clean_model_output(text)


_provider_instance: AiVisionOcrProvider | None = None


def get_ai_vision_provider() -> AiVisionOcrProvider:
    global _provider_instance
    if _provider_instance is None:
        _provider_instance = AiVisionOcrProvider()
    return _provider_instance

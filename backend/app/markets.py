"""市场区域识别: 按代码后缀区分 A股 / 港股 / 美股。

TickFlow 符号约定: 000001.SZ / 0700.HK / AAPL.US。
所有 A股特有逻辑 (涨跌停、连板、选股 universe、交易时段) 通过 get_region 分流。
"""
from __future__ import annotations

from functools import lru_cache

# 后缀 → 区域。SDK 同款映射 (tickflow/utils.py symbol_suffix_region_map)。
_SUFFIX_REGION = {"SH": "CN", "SZ": "CN", "BJ": "CN", "HK": "HK", "US": "US"}

CN = "CN"
HK = "HK"
US = "US"

REGION_LABEL = {CN: "A股", HK: "港股", US: "美股"}


@lru_cache(maxsize=65536)
def get_region(symbol: str) -> str:
    """返回符号所属市场区域: CN / HK / US。无法识别时默认 CN。"""
    if not symbol:
        return CN
    suffix = symbol.rsplit(".", 1)[-1].upper() if "." in symbol else ""
    return _SUFFIX_REGION.get(suffix, CN)


def is_cn(symbol: str) -> bool:
    return get_region(symbol) == CN


def is_hk_or_us(symbol: str) -> bool:
    return get_region(symbol) in (HK, US)

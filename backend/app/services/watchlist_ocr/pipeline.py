"""截图 → OCR 文本 → 抽代码 (A股/港股/美股) → instruments 校验 + 数量/成本提取。"""
from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import polars as pl

from app.services.watchlist_ocr.provider import OcrProvider, get_ocr_provider

logger = logging.getLogger(__name__)

# A 股 / ETF 六位代码；含 OCR 常见拆分：5881 70 / 5881\n70
_CODE_RE = re.compile(r"(?<!\d)(\d{6})(?!\d)")
_SPLIT_CODE_RE = re.compile(r"(?<!\d)(\d{3,5})\s+(\d{1,3})(?!\d)")
# 港股 4–5 位数字码 (前后无相邻数字)
_HK_CODE_RE = re.compile(r"(?<!\d)(\d{4,5})(?!\d)")
# 美股字母代码: 2–5 个字母, 可含点/连字符后缀 (BRK.B)
_US_CODE_RE = re.compile(r"(?<![A-Za-z.])([A-Za-z]{2,5}(?:\.[A-Za-z])?)(?![A-Za-z])")
# 持仓数量: 1,000 / 1000 / 1.5万 / 100股 / ×100
_QTY_RE = re.compile(r"(?<![\d.])(?:[×xX]\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(万|千)?\s*股(?!\d)")
_QTY_BARE_RE = re.compile(r"(?<![\d.])(\d{1,3}(?:,\d{3})+|\d{2,})(?![\d.]|%)")
# 成本/现价: 小数 (单价)
_COST_RE = re.compile(r"(?<![\d.])(\d{1,6}\.\d{1,4})(?!\d)")

# OCR 常见字母-数字混淆 (0↔O, 1↔I, 5↔S, 8↔B, 2↔Z)
_US_CONFUSABLES = str.maketrans("OISBZ", "01582")

_HEADER_WORDS = ("代码", "名称", "持仓", "数量", "成本", "现价", "盈亏", "市值", "操作", "涨幅", "涨跌幅")


@dataclass
class ImportCandidate:
    code: str
    symbol: str | None
    name: str | None
    matched: bool
    market: str = "CN"          # CN / HK / US
    qty: float | None = None    # 持仓数量 (股)
    available: float | None = None  # 可用数量 (股)
    cost: float | None = None   # 成本价
    already_in_watchlist: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def extract_codes(text: str) -> list[str]:
    """从 OCR 文本按出现顺序去重抽取六位代码 (A股, 兼容旧调用)。"""
    return _extract_cn_codes(text)


def _extract_cn_codes(text: str) -> list[str]:
    if not text:
        return []

    def _join_split(m: re.Match[str]) -> str:
        joined = m.group(1) + m.group(2)
        return joined if len(joined) == 6 else m.group(0)

    normalized = _SPLIT_CODE_RE.sub(_join_split, text)

    seen: set[str] = set()
    codes: list[str] = []
    for m in _CODE_RE.finditer(normalized):
        code = m.group(1)
        if code in seen:
            continue
        seen.add(code)
        codes.append(code)
    return codes


def _qty_value(num: str, unit: str | None) -> float:
    v = float(num.replace(",", ""))
    if unit == "万":
        v *= 10000
    elif unit == "千":
        v *= 1000
    return v


def _parse_qty_cost(line: str) -> tuple[float | None, float | None]:
    """从单行提取 (数量, 成本价)。尽力而为的启发式:
    - 数量: 「100股」「1,000股」「×200」「2万」优先; 否则取无小数点的大整数 (≥10)
    - 成本: 第一个 1-6 位整数 + 2-4 位小数的数
    """
    qty: float | None = None
    m = _QTY_RE.search(line)
    if m:
        qty = _qty_value(m.group(1), m.group(2))
    else:
        m2 = _QTY_BARE_RE.search(line)
        if m2:
            v = float(m2.group(1).replace(",", ""))
            if 10 <= v <= 100_000_000:
                qty = v

    cost: float | None = None
    m3 = _COST_RE.search(line)
    if m3:
        c = float(m3.group(1))
        if 0.01 <= c <= 999999:
            cost = c
    return qty, cost


def build_instrument_lookups(data_dir: Path) -> tuple[dict[str, str], dict[str, str]]:
    """构建 code→symbol、symbol→name（股票 + ETF）。"""
    code_to_symbol: dict[str, str] = {}
    symbol_to_name: dict[str, str] = {}

    paths: list[Path] = [
        data_dir / "instruments" / "instruments.parquet",
    ]
    etf_dir = data_dir / "instruments_etf"
    if etf_dir.is_dir():
        paths.extend(sorted(etf_dir.glob("*.parquet")))

    for path in paths:
        if not path.exists():
            continue
        try:
            df = pl.read_parquet(path)
            _absorb_cn_rows(df, code_to_symbol, symbol_to_name)
        except Exception as e:  # noqa: BLE001
            logger.debug("read instruments %s failed: %s", path, e)

    return code_to_symbol, symbol_to_name


def _absorb_cn_rows(
    df: pl.DataFrame,
    code_to_symbol: dict[str, str],
    symbol_to_name: dict[str, str],
) -> None:
    if "symbol" not in df.columns:
        return
    has_code = "code" in df.columns
    has_name = "name" in df.columns
    for row in df.iter_rows(named=True):
        symbol = str(row.get("symbol") or "").strip()
        if not symbol:
            continue
        code = str(row.get("code") or "").strip() if has_code else ""
        if not (len(code) == 6 and code.isdigit()):
            bare = symbol.split(".", 1)[0]
            if len(bare) == 6 and bare.isdigit():
                code = bare
        if len(code) == 6 and code.isdigit():
            code_to_symbol.setdefault(code, symbol)
        if has_name:
            name = str(row.get("name") or "").strip()
            if name:
                symbol_to_name.setdefault(symbol, name)


def build_hk_us_lookups(
    data_dir: Path,
) -> tuple[dict[str, str], dict[str, str], dict[str, str], dict[str, str]]:
    """构建港美股字典: (hk_code→symbol, us_code→symbol, symbol→name, name→symbol)。

    港股 code 4-5 位数字; 美股 code 为字母 (统一大写, 点号统一为 '.')。
    name→symbol 双向表用于行内名称消歧。
    """
    hk_code: dict[str, str] = {}
    us_code: dict[str, str] = {}
    symbol_to_name: dict[str, str] = {}
    name_to_symbol: dict[str, str] = {}

    for exchange, code_map in (("hk", hk_code), ("us", us_code)):
        path = data_dir / f"instruments_{exchange}" / "instruments.parquet"
        if not path.exists():
            continue
        try:
            df = pl.read_parquet(path)
        except Exception as e:  # noqa: BLE001
            logger.debug("read %s failed: %s", path, e)
            continue
        if "symbol" not in df.columns:
            continue
        for row in df.iter_rows(named=True):
            symbol = str(row.get("symbol") or "").strip()
            if not symbol:
                continue
            code = str(row.get("code") or "").strip()
            name = str(row.get("name") or "").strip()
            if code:
                code_map.setdefault(code.upper(), symbol)
            if name:
                symbol_to_name.setdefault(symbol, name)
                # 港股名称可能含空格差异, 用去空格键做消歧索引
                name_to_symbol.setdefault(re.sub(r"\s+", "", name), symbol)
    return hk_code, us_code, symbol_to_name, name_to_symbol


def extract_line_candidates(
    text: str,
    code_to_symbol: dict[str, str] | None,
    hk_code_to_symbol: dict[str, str] | None,
    us_code_to_symbol: dict[str, str] | None,
) -> list[tuple[str, str, str]]:
    """按行解析文本 → [(code, market, symbol_hint)]，保持出现顺序。

    market: CN/HK/US。symbol_hint 为已匹配到的标准 symbol (未匹配为空串)。
    """
    return [
        (code, market, symbol)
        for code, market, symbol, _qty, _cost, _spans in _parse_lines(
            text, code_to_symbol or {}, hk_code_to_symbol or {}, us_code_to_symbol or {}
        )
    ]


# 行内裸整数 token: 港股代码 / 数量的候选来源
_INT_TOKEN_RE = re.compile(r"(?<![\d.])(\d{1,3}(?:,\d{3})+|\d{2,6})(?![\d.]|%)")
# 港股代码 token: 3–5 位纯数字 (无千分位逗号 — 带逗号的是数量)
_HK_TOKEN_RE = re.compile(r"(?<![\d.])(\d{3,5})(?![\d.]|%)")


# AI 视觉通道输出行: 「CN - 长鑫科技 1000 55.135」(市场前缀 + 可选代码)
_AI_LINE_RE = re.compile(r"^\s*(CN|HK|US)\s+(.+)$")


def _parse_ai_line(
    market: str,
    rest: str,
    cn_code_to_symbol: dict[str, str],
    hk_code_to_symbol: dict[str, str],
    us_code_to_symbol: dict[str, str],
    name_to_symbol: dict[str, str],
    seen: set[str],
) -> list[tuple[str, str, str, float | None, float | None]]:
    """解析 AI 通道的结构化行。信任市场前缀, 代码缺失/无效时按名称反查。"""
    tokens = rest.strip().split()
    code_map = {"CN": cn_code_to_symbol, "HK": hk_code_to_symbol, "US": us_code_to_symbol}[market]
    symbol = None
    code = ""
    qty = None
    available = None
    cost = None

    for tok in tokens:
        if tok == "-":
            continue
        upper = tok.upper()
        if symbol is None:
            hit = code_map.get(upper) or code_map.get(upper.lstrip("0")) or code_map.get(upper.zfill(5))
            if hit:
                symbol, code = hit, tok
                continue
        # 数值 token: 小数 → 成本; 第一个整数 → 持仓数量; 第二个整数 → 可用数量
        try:
            if "." in tok or "," in tok:
                v = float(tok.replace(",", ""))
                if cost is None and 0.01 <= v <= 999999:
                    cost = v
            else:
                v = float(tok)
                if not 1 <= v <= 100_000_000:
                    continue
                if qty is None:
                    qty = v
                elif available is None:
                    available = v
        except ValueError:
            pass

    if symbol is None:
        # 名称反查: 同市场最长命中优先, 无同市场命中再取全市场最长命中
        normalized = re.sub(r"\s+", "", rest)
        best_same: tuple[str, str] | None = None
        best_any: tuple[str, str] | None = None
        for name, sym in name_to_symbol.items():
            if sym in seen or len(name) < 2:
                continue
            if name not in normalized:
                continue
            region = sym.rsplit(".", 1)[-1].upper()
            is_same = (region == market) or (market == "CN" and region not in ("HK", "US"))
            if is_same and (best_same is None or len(name) > len(best_same[0])):
                best_same = (name, sym)
            if best_any is None or len(name) > len(best_any[0]):
                best_any = (name, sym)
        hit = best_same or best_any
        if hit:
            code, symbol = hit
    if symbol is None or symbol in seen:
        return []
    seen.add(symbol)
    return [(code or symbol, market, symbol, qty, cost, available)]


def _parse_lines(
    text: str,
    cn_code_to_symbol: dict[str, str],
    hk_code_to_symbol: dict[str, str],
    us_code_to_symbol: dict[str, str],
    name_to_symbol: dict[str, str] | None = None,
) -> list[tuple[str, str, str, float | None, float | None, list[tuple[int, int]]]]:
    """按行解析持仓记录。

    返回 [(code, market, symbol, qty, cost, code_spans)]。
    - A股: 6 位码命中 A股字典 (优先)
    - 美股: 字母 token 命中美股字典 (含 OCR 混淆修正)
    - 港股: 无 A股/美股命中时, 行内首个命中港股字典的 3–5 位纯数字 token
    - 名称兜底: 代码为 - 或未命中时, 用行内名称反查 (name_to_symbol, 已去空格归一)
    - qty/cost: 遮蔽代码 token 后提取; 候选最终由用户确认, 宁多勿漏
    """
    results: list[tuple[str, str, str, float | None, float | None, list[tuple[int, int]]]] = []
    seen: set[str] = set()

    def _join_split(m: re.Match[str]) -> str:
        # 「5881 70」拆分码拼回 6 位 — 仅当拼回后确实是 A股代码才拼,
        # 避免「200 550.00」这类数量+价格被错误合并
        joined = m.group(1) + m.group(2)
        if len(joined) == 6 and cn_code_to_symbol.get(joined):
            return joined
        return m.group(0)

    for raw_line in (text or "").splitlines():
        line = _SPLIT_CODE_RE.sub(_join_split, raw_line)

        # AI 通道结构化行 (「CN - 长鑫科技 1000 55.135」): 走专用解析, 信任市场前缀
        ai_m = _AI_LINE_RE.match(line)
        if ai_m:
            for code, market, symbol, qty, cost, available in _parse_ai_line(
                ai_m.group(1), ai_m.group(2),
                cn_code_to_symbol, hk_code_to_symbol, us_code_to_symbol,
                name_to_symbol or {}, seen,
            ):
                results.append((code, market, symbol, qty, cost, [], available))
                # noqa 注意: available 由 _parse_ai_line 返回值第 6 位携带
            continue

        if any(w in line for w in _HEADER_WORDS) and not _CODE_RE.search(line):
            continue

        code_spans: list[tuple[int, int]] = []
        line_hits: list[tuple[str, str, str]] = []

        # ① A股 6 位码
        for m in _CODE_RE.finditer(line):
            symbol = cn_code_to_symbol.get(m.group(1))
            if symbol and symbol not in seen:
                seen.add(symbol)
                line_hits.append((m.group(1), "CN", symbol))
                code_spans.append(m.span())

        # ② 美股字母码
        for m in _US_CODE_RE.finditer(line):
            token = m.group(1).upper()
            symbol = us_code_to_symbol.get(token)
            if not symbol:
                symbol = us_code_to_symbol.get(token.translate(_US_CONFUSABLES))
            if symbol and symbol not in seen:
                seen.add(symbol)
                line_hits.append((token, "US", symbol))
                code_spans.append(m.span())

        # ③ 港股 3–5 位纯数字码: 无 A股/美股命中时才扫, 避免数量被抢识别
        if not line_hits and hk_code_to_symbol:
            for m in _HK_TOKEN_RE.finditer(line):
                token = m.group(1)
                symbol = (
                    hk_code_to_symbol.get(token)
                    or hk_code_to_symbol.get(token.lstrip("0"))
                    or hk_code_to_symbol.get(token.zfill(5))
                )
                if symbol:
                    if symbol not in seen:
                        seen.add(symbol)
                        line_hits.append((token, "HK", symbol))
                        code_spans.append(m.span())
                    break  # 一行只取一个港股持仓; 已见过的也不继续抢其他 token

        # ④ 名称兜底: 无任何代码命中且行内含字典名称 → 名称反查 (截图不显示代码的场景)
        if not line_hits and name_to_symbol:
            normalized_line = re.sub(r"\s+", "", line)
            best: tuple[str, str] | None = None  # (name, symbol), 取最长名称命中
            for name, symbol in name_to_symbol.items():
                if symbol in seen:
                    continue
                if len(name) >= 2 and name in normalized_line:
                    if best is None or len(name) > len(best[0]):
                        best = (name, symbol)
            if best:
                name, symbol = best
                seen.add(symbol)
                region = symbol.rsplit(".", 1)[-1].upper()
                market = "HK" if region == "HK" else "US" if region == "US" else "CN"
                line_hits.append((name, market, symbol))
                code_spans = []  # 名称行无从遮蔽代码, 数量解析依赖 QTY/INT 规则

        if not line_hits:
            continue

        # 数量/成本: 遮蔽代码与成本 token 后解析
        masked = line
        for a, b in code_spans:
            masked = masked[:a] + " " * (b - a) + masked[b:]
        cost_m = _COST_RE.search(masked)
        cost = None
        cost_span: list[tuple[int, int]] = []
        if cost_m and 0.01 <= float(cost_m.group(1)) <= 999999:
            cost = float(cost_m.group(1))
            cost_span = [cost_m.span()]
        for a, b in cost_span:
            masked = masked[:a] + " " * (b - a) + masked[b:]

        qty = None
        m = _QTY_RE.search(masked)
        if m:
            qty = _qty_value(m.group(1), m.group(2))
        else:
            m2 = _INT_TOKEN_RE.search(masked)
            if m2:
                v = float(m2.group(1).replace(",", ""))
                if 1 <= v <= 100_000_000:
                    qty = v

        for code, market, symbol in line_hits:
            results.append((code, market, symbol, qty, cost, code_spans))

    return results


def resolve_candidates(
    codes: list[str],
    code_to_symbol: dict[str, str],
    symbol_to_name: dict[str, str],
    existing_symbols: set[str] | None = None,
) -> list[ImportCandidate]:
    """旧接口: 仅 A股六位码 → 候选 (兼容既有单测)。"""
    existing = existing_symbols or set()
    out: list[ImportCandidate] = []
    for code in codes:
        symbol = code_to_symbol.get(code)
        matched = symbol is not None
        name = symbol_to_name.get(symbol) if symbol else None
        out.append(
            ImportCandidate(
                code=code,
                symbol=symbol,
                name=name,
                matched=matched,
                already_in_watchlist=bool(symbol and symbol in existing),
            )
        )
    return out


def import_watchlist_image(
    image_bytes: bytes,
    data_dir: Path,
    *,
    existing_symbols: set[str] | None = None,
    provider: OcrProvider | None = None,
) -> dict[str, Any]:
    """识别截图并返回候选列表（不写入自选）。

    双通道: AI 视觉 (设置页已配置 AI 时, 对港股/美股/数量成本识别更准) 优先,
    失败或未配置时回退 Tesseract + 正则。两通道输出都走同一套按行解析管线。
    """
    ocr: OcrProvider | None = provider
    text: str | None = None
    if ocr is None:
        from app.services.watchlist_ocr.ai_vision import AiVisionOcrProvider

        ai = AiVisionOcrProvider()
        if ai.available():
            try:
                text = ai.extract_text(image_bytes)
                if text:
                    ocr = ai
            except Exception as e:  # noqa: BLE001
                logger.warning("ai_vision OCR failed, fallback to tesseract: %s", e)
        if ocr is None:
            ocr = get_ocr_provider()

    if not ocr.available():
        raise RuntimeError(
            f"OCR 引擎「{ocr.name}」不可用。请安装 Tesseract："
            "macOS 执行 brew install tesseract tesseract-lang；"
            "Windows 可安装 UB Mannheim 发行版或执行 choco install tesseract；"
            "Linux/Docker 安装 tesseract-ocr（官方镜像已内置）。"
        )

    if text is None:
        text = ocr.extract_text(image_bytes)

    code_to_symbol, symbol_to_name = build_instrument_lookups(data_dir)
    hk_code, us_code, hk_us_names, _name_to_sym = build_hk_us_lookups(data_dir)

    # 名称反查字典 (去空格归一): 截图不显示代码时按名称兜底。A股名称常含空格 (粤 传 媒)。
    name_lookup: dict[str, str] = dict(_name_to_sym)
    for symbol, name in symbol_to_name.items():
        key = re.sub(r"\s+", "", name)
        if len(key) >= 2:
            name_lookup.setdefault(key, symbol)

    existing = existing_symbols or set()
    all_names = {**symbol_to_name, **hk_us_names}

    parsed = _parse_lines(text, code_to_symbol, hk_code, us_code, name_lookup)
    candidates = [
        ImportCandidate(
            code=code,
            symbol=symbol,
            name=all_names.get(symbol),
            matched=True,
            market=market,
            qty=qty,
            cost=cost,
            already_in_watchlist=bool(symbol in existing),
        )
        for code, market, symbol, qty, cost, _spans in parsed
    ]

    matched = [c for c in candidates if c.matched]
    unmatched = [c for c in candidates if not c.matched]

    return {
        "provider": ocr.name,
        "raw_text": text,
        "codes": [c.code for c in candidates],
        "candidates": [c.to_dict() for c in candidates],
        "matched_count": len(matched),
        "unmatched_count": len(unmatched),
    }

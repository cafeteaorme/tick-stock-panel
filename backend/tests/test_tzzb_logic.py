"""tzzb 纯逻辑单测: 市场映射 / 清仓轮次推导 / 数值清洗 (不触网、不落盘)。"""
from app.services.tzzb import _derive_cleared, _f_pl, _market_suffix


class TestMarketSuffix:
    def test_hk_5digit(self):
        assert _market_suffix("176", "00700") == ".HK"

    def test_cn_6digit_sh(self):
        for c in ("600036", "515880", "900901"):
            assert _market_suffix("", c) == ".SH"

    def test_cn_6digit_sz(self):
        for c in ("000001", "300750"):
            assert _market_suffix("", c) == ".SZ"

    def test_cn_6digit_bj(self):
        for c in ("430047", "832566"):
            assert _market_suffix("", c) == ".BJ"

    def test_fallback_market_field(self):
        # "111111" 不符合任何 A 股开头规则 (1 开头), 才会走账本 market 字段兜底
        assert _market_suffix("2", "111111") == ".SH"
        assert _market_suffix("1", "111111") == ".SZ"
        assert _market_suffix("12", "111111") == ".BJ"
        assert _market_suffix("176", "1234") == ".HK"

    def test_unknown_defaults_sz(self):
        assert _market_suffix("666", "abcd") == ".SZ"


class TestDeriveCleared:
    @staticmethod
    def _t(acc, sym, bs, qty, amount, date, time_="", profit=0, fee=0, name="x"):
        return {"account_id": acc, "symbol": sym, "bs": bs, "qty": qty,
                "amount": amount, "date": date, "time": time_, "profit": profit,
                "fee": fee, "name": name}

    def test_single_round(self):
        trades = [
            self._t("a", "600036.SH", "B", 100, 3000.0, "2026-01-05", "09:31:00"),
            self._t("a", "600036.SH", "B", 100, 3600.0, "2026-01-06"),
            self._t("a", "600036.SH", "S", 200, 7600.0, "2026-01-10", profit=1000.0, fee=12.5),
        ]
        rounds = _derive_cleared(trades)
        assert len(rounds) == 1
        r = rounds[0]
        assert r["symbol"] == "600036.SH"
        assert r["qty"] == 200
        assert r["avg_cost"] == 33.0
        assert r["avg_sell"] == 38.0
        assert r["profit"] == 1000.0
        assert r["fee"] == 12.5
        assert r["first_buy"] == "2026-01-05"
        assert r["last_sell"] == "2026-01-10"

    def test_profit_fallback_from_cost(self):
        # 账本 profit 恒 0 时按 卖出额-买入成本 推算
        trades = [
            self._t("a", "X", "B", 10, 100.0, "2026-01-05"),
            self._t("a", "X", "S", 10, 120.0, "2026-01-06"),
        ]
        r = _derive_cleared(trades)[0]
        assert r["profit"] == 20.0

    def test_partial_then_clear_two_rounds(self):
        trades = [
            self._t("a", "X", "B", 100, 1000.0, "2026-01-05"),
            self._t("a", "X", "S", 100, 1100.0, "2026-01-06"),
            self._t("a", "X", "B", 200, 1800.0, "2026-02-05"),
            self._t("a", "X", "S", 200, 2000.0, "2026-02-06"),
        ]
        rounds = _derive_cleared(trades)
        assert [r["qty"] for r in rounds] == [100, 200]
        assert [r["profit"] for r in rounds] == [100, 200]

    def test_open_position_not_cleared(self):
        trades = [self._t("a", "X", "B", 100, 1000.0, "2026-01-05")]
        assert _derive_cleared(trades) == []

    def test_accounts_isolated(self):
        trades = [
            self._t("a", "X", "B", 100, 1000.0, "2026-01-05"),
            self._t("b", "X", "B", 100, 1000.0, "2026-01-05"),
            self._t("a", "X", "S", 100, 1100.0, "2026-01-06"),
        ]
        rounds = _derive_cleared(trades)
        assert len(rounds) == 1 and rounds[0]["account_id"] == "a"

    def test_sell_before_buy_no_round(self):
        # 脏数据 (先卖后买) 不应产生清仓轮次
        trades = [
            self._t("a", "X", "S", 100, 1100.0, "2026-01-05"),
            self._t("a", "X", "B", 100, 1000.0, "2026-01-06"),
        ]
        assert _derive_cleared(trades) == []

    def test_input_order_irrelevant(self):
        trades = [
            self._t("a", "X", "S", 100, 120.0, "2026-01-06"),
            self._t("a", "X", "B", 100, 100.0, "2026-01-05"),
        ]
        r = _derive_cleared(trades)[0]
        assert r["profit"] == 20.0
        assert r["first_buy"] == "2026-01-05"


class TestFPl:
    def test_parses_currency_and_commas(self):
        assert _f_pl("HK$1,234.5") == 1234.5
        assert _f_pl("$12") == 12.0

    def test_invalid_returns_none(self):
        assert _f_pl(None) is None
        assert _f_pl("abc") is None
        import math
        assert _f_pl(float("nan")) is None

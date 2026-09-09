"""TickFlow Stock Panel backend."""

import sys

__version__ = "0.1.88"
# 本分支修订号 (cafeteaorme/tick-stock-panel): 版本规则 = 上游版本-修订序号
# 每次发布递增 0.01 且不随上游升级重置 (如 0.1.88-0.01 → 0.1.88-0.02 → 0.1.89-0.03)
__revision__ = "0.19"


def branch_version() -> str:
    """对外展示的完整版本号: 上游版本 + 分支修订, 如 0.1.88-0.02。"""
    return f"{__version__}-{__revision__}"

# Windows 默认 stdout/stderr 编码为 GBK(cp936),TickFlow SDK 内部输出含 emoji 的
# 指数/标的名称(如 \U0001f193)时会抛 UnicodeEncodeError,导致请求失败。
# 进程加载最早阶段强制 UTF-8,根治此类编码崩溃。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass

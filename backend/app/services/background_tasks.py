"""后台任务统一启动入口 (main.lifespan 调用)。

收敛: 行情轮询/日K 盘后管道/扩展表拉取/财务同步/港美股分时刷新/
投资账本定时同步+港股价格刷新等所有常驻任务集中在此注册与日志。
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def start_all(store_dir, repo, capset, app_state) -> None:
    started: list[str] = []

    # 1) 日K/分钟盘后管道 (APScheduler)
    try:
        from app.services import daily_pipeline

        daily_pipeline.set_app_state(app_state)
        scheduler = daily_pipeline.start_scheduler(repo, capset)
        app_state.scheduler = scheduler
        started.append("daily-pipeline")
    except Exception as e:  # noqa: BLE001
        logger.warning("scheduler not started: %s", e)

    # 2) 扩展表定时拉取
    try:
        from app.services.ext_pull import pull_scheduler

        pull_scheduler.start(store_dir)
        pull_scheduler.refresh(store_dir)
        app_state.pull_scheduler = pull_scheduler
        started.append("ext-pull")
    except Exception as e:  # noqa: BLE001
        logger.warning("ext pull not started: %s", e)

    # 3) 港美股分时后台刷新 (当日已看标的)
    try:
        from app.services import hk_us_intraday

        hk_us_intraday.start_background_refresh(store_dir, store_dir / "user_data")
        started.append("hk-us-intraday")
    except Exception as e:  # noqa: BLE001
        logger.warning("hk_us_intraday refresh start failed: %s", e)

    # 4) 投资账本: 交易日定时同步 + 持仓港股价格刷新
    try:
        from app.services import tzzb

        tzzb.start_background_sync()
        tzzb.start_hk_price_refresh()
        started.append("tzzb")
    except Exception as e:  # noqa: BLE001
        logger.warning("tzzb sync start failed: %s", e)

    logger.info("后台任务已启动: %s", ", ".join(started))

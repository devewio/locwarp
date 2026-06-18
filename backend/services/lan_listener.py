"""On-demand LAN listener for phone control.

The primary backend binds to 127.0.0.1 (loopback only) so the full API —
device control, bookmarks, the websocket joystick — is never reachable
from the network. When the user explicitly enables phone control, this
manager spins up a *second* uvicorn server bound to 0.0.0.0 on
PHONE_LAN_PORT that serves ONLY the phone-facing routes
(``lan_phone_router``). Disabling phone control shuts it back down.

Design notes:
  * The LAN app runs ``lifespan="off"``. Device discovery / watchdog /
    keepalive belong to the primary server's lifespan and must run
    exactly once; the phone routes only read module-level
    ``main.app_state`` and don't need any lifespan setup.
  * Both servers share the *same* asyncio event loop (the LAN server runs
    as a task on the primary loop), so there's no cross-thread access to
    ``app_state`` / ``simulation_engines`` / ``_PhoneAuth``.
  * The enabled state is intentionally NOT persisted across restarts:
    exposing phone control to the LAN is a sensitive action that should
    be re-confirmed each session.
"""

from __future__ import annotations

import asyncio
import logging

import uvicorn
from fastapi import FastAPI

logger = logging.getLogger("locwarp.lan")

# How long start() waits for the socket to be accepting before declaring
# failure, and how long stop() waits for graceful shutdown before giving
# up on the task.
_START_DEADLINE_S = 3.0
_STOP_DEADLINE_S = 5.0


class LanListenerManager:
    """Start/stop a 0.0.0.0 uvicorn server exposing only phone routes."""

    def __init__(self) -> None:
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None

    @property
    def is_running(self) -> bool:
        return self._server is not None and self._task is not None and not self._task.done()

    async def start(self) -> tuple[bool, str]:
        """Open the LAN listener. Idempotent: no-op if already running.
        Returns (ok, message)."""
        if self.is_running:
            return True, "already running"

        # Clean up a finished/failed task reference from a prior attempt.
        if self._task is not None and self._task.done():
            self._server = None
            self._task = None

        from config import PHONE_LAN_PORT
        from api.phone_control import lan_phone_router

        lan_app = FastAPI(
            title="LocWarp Phone (LAN)",
            docs_url=None,
            redoc_url=None,
            openapi_url=None,
        )
        lan_app.include_router(lan_phone_router)

        config = uvicorn.Config(
            lan_app,
            host="0.0.0.0",
            port=PHONE_LAN_PORT,
            lifespan="off",
            access_log=True,
            log_level="info",
        )
        server = uvicorn.Server(config)
        # uvicorn installs signal handlers by default, which fails on a
        # non-main thread / when not the top-level server. We're a nested
        # server on an already-running loop, so disable them.
        server.install_signal_handlers = lambda: None

        task = asyncio.create_task(server.serve(), name="lan-phone-listener")

        # Wait for the socket to be accepting (server.started flips True
        # after the listener sockets are bound and serving).
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _START_DEADLINE_S
        while loop.time() < deadline:
            if task.done():
                # serve() returned/raised before becoming ready — bind
                # failure (port busy, permission), surface it.
                exc = task.exception() if not task.cancelled() else None
                msg = f"LAN listener failed to start: {exc}" if exc else "LAN listener exited during startup"
                logger.error(msg)
                self._server = None
                self._task = None
                return False, msg
            if server.started:
                self._server = server
                self._task = task
                logger.info("Phone LAN listener started on 0.0.0.0:%d", PHONE_LAN_PORT)
                return True, "started"
            await asyncio.sleep(0.05)

        # Timed out without becoming ready — tear the task down.
        logger.error("LAN listener did not become ready within %.1fs", _START_DEADLINE_S)
        server.should_exit = True
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=1.0)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            pass
        self._server = None
        self._task = None
        return False, "LAN listener startup timed out"

    async def stop(self) -> None:
        """Gracefully shut the LAN listener down. Idempotent."""
        server, task = self._server, self._task
        self._server = None
        self._task = None
        if server is None or task is None:
            return
        server.should_exit = True
        try:
            await asyncio.wait_for(task, timeout=_STOP_DEADLINE_S)
        except asyncio.TimeoutError:
            logger.warning("LAN listener did not stop within %.1fs; cancelling", _STOP_DEADLINE_S)
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        except (asyncio.CancelledError, Exception):
            logger.debug("LAN listener stop raised", exc_info=True)
        logger.info("Phone LAN listener stopped")


# Module-level singleton.
lan_listener = LanListenerManager()

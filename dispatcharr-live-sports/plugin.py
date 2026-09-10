import json
import os
import sys
import threading

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from client import EngineClient, EngineError
from store import DjangoStore
from sync import format_report, sync

PLUGIN_NAME = "Live Sports"
PLUGIN_VERSION = "0.1.0"


def _settings(context):
    return dict((context or {}).get("settings") or {})


def _logger(context):
    log = (context or {}).get("logger")
    if log:
        return log

    class _Print:
        def info(self, msg, *args):
            print(msg % args if args else msg)

        def warning(self, msg, *args):
            print(msg % args if args else msg)

        def exception(self, msg, *args):
            print(msg % args if args else msg)

    return _Print()


def _notify(message):
    try:
        from core.utils import send_websocket_update
        send_websocket_update("updates", "update", {
            "type": "plugin",
            "plugin": PLUGIN_NAME,
            "message": message,
        })
    except Exception:
        pass


def _client(settings):
    return EngineClient(settings.get("engine_url") or "http://127.0.0.1:7000", token=settings.get("api_token") or "")


def _store(context):
    injected = (context or {}).get("store")
    if injected is not None:
        return injected
    return DjangoStore()


def _interval_seconds(settings):
    if settings.get("_interval_seconds") is not None:
        return float(settings["_interval_seconds"])
    return float(settings.get("sync_interval") or 5) * 60


def _close_connections(closer=None):
    if closer:
        closer()
        return
    try:
        from django.db import close_old_connections
        close_old_connections()
    except Exception:
        pass


class Plugin:
    name = PLUGIN_NAME
    version = PLUGIN_VERSION
    description = "Creates native Dispatcharr channels and EPG rows from the Live Sports engine. Playback URLs stay on the engine and resolve just in time."
    author = "edivad1999"
    help_url = "https://github.com/edivad1999/live-sport-plugin"

    fields = [
        {"id": "_section_engine", "label": "Engine", "type": "info", "description": "The sports engine owns discovery and stream resolution. This plugin never asks for Dispatcharr credentials."},
        {"id": "engine_url", "label": "Engine URL", "type": "string", "default": "http://127.0.0.1:7000", "placeholder": "http://127.0.0.1:7000"},
        {"id": "playback_base_url", "label": "Playback URL", "type": "string", "default": "", "placeholder": "http://host.example:7000"},
        {"id": "api_token", "label": "Engine API token", "type": "string", "default": "", "input_type": "password"},
        {"id": "sports", "label": "Enabled sports", "type": "string", "default": "all", "placeholder": "all  or  football,basketball"},
        {"id": "_section_windows", "label": "Lifecycle", "type": "info", "description": "When channels appear, hide after the estimated end, and delete."},
        {"id": "create_hours", "label": "Create before start (hours)", "type": "number", "default": 12},
        {"id": "hide_hours", "label": "Hide after end (hours)", "type": "number", "default": 2},
        {"id": "delete_hours", "label": "Delete after end (hours)", "type": "number", "default": 24},
        {"id": "missing_grace_minutes", "label": "Missing-event grace (minutes)", "type": "number", "default": 30},
        {"id": "sync_interval", "label": "Sync interval (minutes)", "type": "number", "default": 5},
        {"id": "channel_start", "label": "Channel number start", "type": "number", "default": 5000},
        {"id": "group_prefix", "label": "Group prefix", "type": "string", "default": "Live Sports"},
        {"id": "profiles", "label": "Channel profiles (comma-separated, blank = all)", "type": "string", "default": ""},
        {"id": "enabled", "label": "Scheduler enabled", "type": "boolean", "default": True},
    ]

    actions = [
        {"id": "test_engine", "label": "Test Engine", "description": "Calls the engine status endpoint. Writes nothing.", "button_label": "Test Engine", "button_variant": "outline", "button_color": "blue"},
        {"id": "preview_sync", "label": "Preview Sync", "description": "Shows what Sync Now would change. Writes nothing.", "button_label": "Preview", "button_variant": "outline", "button_color": "blue"},
        {"id": "sync_now", "label": "Sync Now", "description": "Creates, updates, hides, and deletes owned live-sports channels.", "button_label": "Sync Now", "button_variant": "filled", "button_color": "red", "confirm": {"message": "This creates and updates native channels and EPG rows. Continue?"}},
        {"id": "cleanup", "label": "Cleanup", "description": "Hides or deletes owned channels that are past their windows. Does not create channels.", "button_label": "Cleanup", "button_variant": "outline", "button_color": "orange"},
        {"id": "update_scheduler", "label": "Update Scheduler", "description": "Re-arms the background sync thread from the saved interval.", "button_label": "Save Schedule", "button_variant": "filled", "button_color": "green"},
        {"id": "scheduler_status", "label": "Scheduler Status", "description": "Shows whether the background thread is running.", "button_label": "Status", "button_variant": "outline", "button_color": "blue"},
    ]

    def __init__(self):
        self._sync_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._closer = None
        self._last_context = None

    def run(self, action, params, context):
        settings = _settings(context)
        logger = _logger(context)
        self._last_context = context
        if (context or {}).get("closer"):
            self._closer = context["closer"]

        if action == "test_engine":
            return self._test_engine(settings)
        if action == "preview_sync":
            return self._sync(settings, context, logger, dry_run=True)
        if action == "sync_now":
            result = self._sync(settings, context, logger, dry_run=False)
            self._ensure_scheduler(settings, logger)
            return result
        if action == "cleanup":
            return self._cleanup(settings, context, logger)
        if action == "update_scheduler":
            self._restart_scheduler(settings, logger)
            return {"status": "ok", "message": self._scheduler_message(settings)}
        if action == "scheduler_status":
            return {"status": "ok", "message": self._scheduler_message(settings)}
        return {"status": "error", "message": "Unknown action %s" % action}

    def stop(self, context):
        logger = _logger(context)
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=10)
        self._thread = None
        logger.info("Live Sports scheduler stopped")

    def _test_engine(self, settings):
        try:
            data = _client(settings).status()
        except EngineError as err:
            return {"status": "error", "message": str(err)}
        return {
            "status": "ok",
            "message": "Engine %s, api v%s, %s cached events" % (
                data.get("engineVersion"),
                data.get("apiVersion"),
                data.get("cachedEvents"),
            ),
        }

    def _sync(self, settings, context, logger, dry_run):
        if not self._sync_lock.acquire(blocking=False):
            return {"status": "skipped", "message": "sync already running"}
        try:
            store = _store(context)
            client = context.get("client") if context else None
            client = client or _client(settings)
            now = context.get("now") if context else None
            with store.atomic():
                report = sync(store, client, settings, now=now, dry_run=dry_run)
            text = format_report(report, preview=dry_run)
            logger.info(text)
            if not dry_run and not report.get("failed"):
                _notify(text.split("\n", 1)[0])
            status = "error" if report.get("failed") else "ok"
            return {"status": status, "message": text, "report": report}
        finally:
            self._sync_lock.release()

    def _cleanup(self, settings, context, logger):
        if not self._sync_lock.acquire(blocking=False):
            return {"status": "skipped", "message": "sync already running"}
        try:
            from lifecycle import decide, parse_utc
            from sync import empty_report

            store = _store(context)
            now = (context or {}).get("now")
            from datetime import datetime, timezone
            now = now or datetime.now(timezone.utc)
            report = empty_report()
            dry_run = bool((context or {}).get("dry_run"))
            with store.atomic():
                for owned in store.list_owned():
                    stub = {
                        "id": owned["event_id"],
                        "startTime": owned.get("start_time"),
                        "estimatedEndTime": owned.get("end_time"),
                    }
                    action = decide(
                        stub,
                        settings,
                        now=now,
                        last_seen=parse_utc(owned.get("last_seen")),
                        missing=True,
                    )
                    if action == "HIDE" and not owned.get("hidden"):
                        if not dry_run:
                            store.hide(owned["event_id"])
                        report["channels_hidden"] += 1
                    elif action == "DELETE":
                        if not dry_run:
                            store.delete_owned(owned["event_id"])
                        report["channels_deleted"] += 1
                    else:
                        report["channels_unchanged"] += 1
            text = format_report(report)
            logger.info(text)
            return {"status": "ok", "message": text, "report": report}
        finally:
            self._sync_lock.release()

    def _ensure_scheduler(self, settings, logger):
        if not bool(settings.get("enabled", True)):
            return
        if self._thread and self._thread.is_alive():
            return
        self._restart_scheduler(settings, logger)

    def _restart_scheduler(self, settings, logger):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
        self._stop = threading.Event()
        if not bool(settings.get("enabled", True)):
            self._thread = None
            logger.info("Live Sports scheduler left stopped")
            return
        interval = _interval_seconds(settings)
        closer = self._closer
        context = self._last_context

        def loop():
            while not self._stop.is_set():
                try:
                    if not self._stop.is_set():
                        self._sync(settings, context, logger, dry_run=False)
                except Exception:
                    logger.exception("Live Sports scheduled sync failed")
                finally:
                    _close_connections(closer)
                if self._stop.wait(interval):
                    break

        self._thread = threading.Thread(target=loop, name="dispatcharr-live-sports", daemon=True)
        self._thread.start()
        logger.info("Live Sports scheduler every %s seconds", interval)

    def _scheduler_message(self, settings):
        running = bool(self._thread and self._thread.is_alive())
        return json.dumps({
            "running": running,
            "enabled": bool(settings.get("enabled", True)),
            "interval_seconds": _interval_seconds(settings),
        })

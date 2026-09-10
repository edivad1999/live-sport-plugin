import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from client import EngineError
from lifecycle import decide
from plugin import Plugin
from store import MemoryStore
from sync import playback_url, sync, tvg_id_for


def utc(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


SETTINGS = {
    "engine_url": "http://127.0.0.1:7000",
    "sports": "all",
    "create_hours": 12,
    "hide_hours": 2,
    "delete_hours": 24,
    "missing_grace_minutes": 30,
    "channel_start": 5000,
    "group_prefix": "Live Sports",
    "profiles": "",
}


def event(event_id="ls_aaaaaaaaaaaaaaaa", **kwargs):
    start = kwargs.pop("startTime", "2026-09-10T18:00:00Z")
    end = kwargs.pop("estimatedEndTime", "2026-09-10T20:30:00Z")
    row = {
        "id": event_id,
        "title": "Inter vs Juventus",
        "sport": "football",
        "league": "Serie A",
        "startTime": start,
        "estimatedEndTime": end,
        "artwork": {"logo": "http://example/logo.png"},
        "playback": {"url": "/api/dispatcharr/v1/events/%s/play.m3u8" % event_id},
    }
    row.update(kwargs)
    return row


class FakeEngine:
    def __init__(self, events=None, fail=False):
        self.events_list = list(events or [])
        self.fail = fail
        self.calls = 0

    def events(self, sports=None):
        self.calls += 1
        if self.fail:
            raise EngineError("engine HTTP 500")
        if sports and sports.strip() and sports.strip().lower() != "all":
            wanted = {part.strip() for part in sports.split(",")}
            return [row for row in self.events_list if row.get("sport") in wanted]
        return list(self.events_list)

    def status(self):
        if self.fail:
            raise EngineError("engine HTTP 500")
        return {"status": "ok", "engineVersion": "3.0.0", "apiVersion": 1, "cachedEvents": len(self.events_list)}


class SyncTests(unittest.TestCase):
    def test_first_sync_creates_channel_and_stable_url(self):
        store = MemoryStore()
        row = event()
        now = utc(2026, 9, 10, 17, 0)
        report = sync(store, FakeEngine([row]), SETTINGS, now=now)
        self.assertEqual(report["channels_created"], 1)
        owned = store.get_owned(row["id"])
        self.assertEqual(owned["tvg_id"], tvg_id_for(row["id"]))
        self.assertEqual(owned["url"], playback_url(SETTINGS["engine_url"], row["id"]))
        self.assertEqual(owned["channel_number"], 5000)
        self.assertTrue(owned["url"].endswith("/api/dispatcharr/v1/events/%s/play.m3u8" % row["id"]))
        self.assertNotIn("cdn.", owned["url"])
        self.assertTrue(owned["has_memberships"])

    def test_named_profiles_are_recorded(self):
        store = MemoryStore()
        settings = dict(SETTINGS)
        settings["profiles"] = "Sports, All"
        now = utc(2026, 9, 10, 17, 0)
        sync(store, FakeEngine([event()]), settings, now=now)
        self.assertEqual(store.get_owned("ls_aaaaaaaaaaaaaaaa")["profiles"], ["Sports", "All"])

    def test_second_sync_ignores_timezone_string_shape(self):
        store = MemoryStore()
        row = event(startTime="2026-09-10T18:00:00Z", estimatedEndTime="2026-09-10T20:30:00Z")
        now = utc(2026, 9, 10, 17, 0)
        sync(store, FakeEngine([row]), SETTINGS, now=now)
        owned = store.get_owned(row["id"])
        owned["start_time"] = "2026-09-10T18:00:00+00:00"
        owned["end_time"] = "2026-09-10T20:30:00+00:00"
        store.owned[row["id"]] = owned
        report = sync(store, FakeEngine([row]), SETTINGS, now=now)
        self.assertEqual(report["channels_updated"], 0)
        self.assertEqual(report["channels_unchanged"], 1)

    def test_second_sync_is_idempotent(self):
        store = MemoryStore()
        row = event()
        now = utc(2026, 9, 10, 17, 0)
        engine = FakeEngine([row])
        sync(store, engine, SETTINGS, now=now)
        report = sync(store, engine, SETTINGS, now=now)
        self.assertEqual(report["channels_created"], 0)
        self.assertEqual(report["channels_unchanged"], 1)
        self.assertEqual(len(store.list_owned()), 1)
        self.assertEqual(store.get_owned(row["id"])["channel_number"], 5000)

    def test_preview_writes_nothing(self):
        store = MemoryStore()
        report = sync(store, FakeEngine([event()]), SETTINGS, now=utc(2026, 9, 10, 17, 0), dry_run=True)
        self.assertEqual(report["channels_created"], 1)
        self.assertEqual(store.list_owned(), [])

    def test_metadata_and_start_time_update(self):
        store = MemoryStore()
        row = event(title="Inter vs Juventus", startTime="2026-09-10T18:00:00Z")
        now = utc(2026, 9, 10, 17, 0)
        sync(store, FakeEngine([row]), SETTINGS, now=now)
        updated = event(title="Inter Milan vs Juventus", startTime="2026-09-10T18:15:00Z")
        report = sync(store, FakeEngine([updated]), SETTINGS, now=now)
        self.assertEqual(report["channels_updated"], 1)
        owned = store.get_owned(row["id"])
        self.assertEqual(owned["name"], "Inter Milan vs Juventus")
        self.assertEqual(owned["start_time"], "2026-09-10T18:15:00Z")
        self.assertEqual(owned["channel_number"], 5000)

    def test_missing_grace_keeps_channel(self):
        store = MemoryStore()
        row = event()
        now = utc(2026, 9, 10, 17, 0)
        sync(store, FakeEngine([row]), SETTINGS, now=now)
        later = now + timedelta(minutes=10)
        report = sync(store, FakeEngine([]), SETTINGS, now=later)
        self.assertEqual(len(store.list_owned()), 1)
        self.assertEqual(report["channels_deleted"], 0)
        self.assertEqual(report["channels_hidden"], 0)

    def test_hide_after_end_window(self):
        store = MemoryStore()
        row = event(startTime="2026-09-10T18:00:00Z", estimatedEndTime="2026-09-10T20:30:00Z")
        sync(store, FakeEngine([row]), SETTINGS, now=utc(2026, 9, 10, 18, 0))
        report = sync(store, FakeEngine([row]), SETTINGS, now=utc(2026, 9, 10, 23, 0))
        self.assertEqual(report["channels_hidden"], 1)
        self.assertTrue(store.get_owned(row["id"])["hidden"])

    def test_delete_after_delete_window(self):
        store = MemoryStore()
        row = event(startTime="2026-09-10T18:00:00Z", estimatedEndTime="2026-09-10T20:30:00Z")
        sync(store, FakeEngine([row]), SETTINGS, now=utc(2026, 9, 10, 18, 0))
        report = sync(store, FakeEngine([row]), SETTINGS, now=utc(2026, 9, 12, 0, 0))
        self.assertEqual(report["channels_deleted"], 1)
        self.assertIsNone(store.get_owned(row["id"]))

    def test_engine_failure_is_nondestructive(self):
        store = MemoryStore()
        row = event()
        now = utc(2026, 9, 10, 17, 0)
        sync(store, FakeEngine([row]), SETTINGS, now=now)
        report = sync(store, FakeEngine([row], fail=True), SETTINGS, now=now)
        self.assertTrue(report["failed"])
        self.assertEqual(len(store.list_owned()), 1)
        self.assertEqual(store.get_owned(row["id"])["name"], "Inter vs Juventus")

    def test_empty_catalogue_uses_grace_not_delete(self):
        store = MemoryStore()
        row = event()
        now = utc(2026, 9, 10, 17, 0)
        sync(store, FakeEngine([row]), SETTINGS, now=now)
        report = sync(store, FakeEngine([]), SETTINGS, now=now + timedelta(minutes=1))
        self.assertEqual(report["channels_deleted"], 0)
        self.assertEqual(len(store.list_owned()), 1)

    def test_channel_numbers_stay_stable(self):
        store = MemoryStore()
        a = event("ls_aaaaaaaaaaaaaaaa", title="A")
        b = event("ls_bbbbbbbbbbbbbbbb", title="B")
        now = utc(2026, 9, 10, 17, 0)
        sync(store, FakeEngine([a, b]), SETTINGS, now=now)
        first = {row["event_id"]: row["channel_number"] for row in store.list_owned()}
        sync(store, FakeEngine([a, b]), SETTINGS, now=now)
        second = {row["event_id"]: row["channel_number"] for row in store.list_owned()}
        self.assertEqual(first, second)
        self.assertEqual(sorted(first.values()), [5000, 5001])

    def test_skip_before_create_window(self):
        store = MemoryStore()
        row = event(startTime="2026-09-11T18:00:00Z", estimatedEndTime="2026-09-11T20:30:00Z")
        report = sync(store, FakeEngine([row]), SETTINGS, now=utc(2026, 9, 10, 17, 0))
        self.assertEqual(report["channels_created"], 0)
        self.assertEqual(store.list_owned(), [])


class LifecycleTests(unittest.TestCase):
    def test_decide_table(self):
        row = event(startTime="2026-09-10T18:00:00Z", estimatedEndTime="2026-09-10T20:30:00Z")
        self.assertEqual(decide(row, SETTINGS, now=utc(2026, 9, 10, 5, 0)), "SKIP")
        self.assertEqual(decide(row, SETTINGS, now=utc(2026, 9, 10, 10, 0)), "UPSERT")
        self.assertEqual(decide(row, SETTINGS, now=utc(2026, 9, 10, 23, 0)), "HIDE")
        self.assertEqual(decide(row, SETTINGS, now=utc(2026, 9, 12, 0, 0)), "DELETE")


class PluginActionTests(unittest.TestCase):
    def _context(self, store, engine, now, **extra):
        ctx = {
            "settings": dict(SETTINGS),
            "store": store,
            "client": engine,
            "now": now,
            "logger": None,
        }
        ctx["settings"]["enabled"] = False
        ctx.update(extra)
        return ctx

    def test_preview_action_writes_nothing(self):
        plugin = Plugin()
        store = MemoryStore()
        result = plugin.run("preview_sync", {}, self._context(store, FakeEngine([event()]), utc(2026, 9, 10, 17, 0)))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(store.list_owned(), [])

    def test_sync_now_creates(self):
        plugin = Plugin()
        store = MemoryStore()
        ctx = self._context(store, FakeEngine([event()]), utc(2026, 9, 10, 17, 0))
        ctx["settings"]["enabled"] = False
        result = plugin.run("sync_now", {}, ctx)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(store.list_owned()), 1)

    def test_overlapping_syncs_skip(self):
        plugin = Plugin()
        store = MemoryStore()
        held = plugin._sync_lock.acquire()
        self.assertTrue(held)
        try:
            result = plugin.run("sync_now", {}, self._context(store, FakeEngine([event()]), utc(2026, 9, 10, 17, 0)))
            self.assertEqual(result["status"], "skipped")
            self.assertEqual(store.list_owned(), [])
        finally:
            plugin._sync_lock.release()

    def test_cleanup_owned_only(self):
        plugin = Plugin()
        store = MemoryStore()
        row = event(startTime="2026-09-10T18:00:00Z", estimatedEndTime="2026-09-10T20:30:00Z")
        ctx = self._context(store, FakeEngine([row]), utc(2026, 9, 10, 18, 0))
        ctx["settings"]["enabled"] = False
        plugin.run("sync_now", {}, ctx)
        store.add_foreign()
        later = self._context(store, FakeEngine([row]), utc(2026, 9, 12, 1, 0))
        result = plugin.run("cleanup", {}, later)
        self.assertEqual(result["report"]["channels_deleted"], 1)
        self.assertIsNone(store.get_owned(row["id"]))
        self.assertEqual(len(store.foreign), 1)

    def test_disable_stops_thread(self):
        plugin = Plugin()
        store = MemoryStore()
        closer_calls = []
        ctx = self._context(
            store,
            FakeEngine([event()]),
            utc(2026, 9, 10, 17, 0),
            closer=lambda: closer_calls.append(1),
        )
        ctx["settings"]["_interval_seconds"] = 0.05
        ctx["settings"]["enabled"] = True
        plugin.run("update_scheduler", {}, ctx)
        self.assertTrue(plugin._thread and plugin._thread.is_alive())
        time.sleep(0.2)
        plugin.stop(ctx)
        self.assertFalse(plugin._thread and plugin._thread.is_alive())
        self.assertGreaterEqual(len(closer_calls), 1)

    def test_fields_never_ask_for_dispatcharr_credentials(self):
        ids = {field["id"] for field in Plugin.fields}
        banned = {"dispatcharr_url", "username", "password", "dispatcharr_user", "dispatcharr_password"}
        self.assertFalse(ids & banned)


if __name__ == "__main__":
    unittest.main()

from datetime import datetime, timezone

from client import EngineError
from lifecycle import decide, parse_utc

PLUGIN_KEY = "dispatcharr-live-sports"
TVG_PREFIX = "live-sports:"
EPG_SOURCE_NAME = "Live Sports Plugin"


def tvg_id_for(event_id):
    return TVG_PREFIX + event_id


def owned_event_id(tvg_id):
    if not tvg_id or not str(tvg_id).startswith(TVG_PREFIX):
        return None
    return str(tvg_id)[len(TVG_PREFIX):]


def empty_report():
    return {
        "events_received": 0,
        "eligible": 0,
        "channels_created": 0,
        "channels_updated": 0,
        "channels_unchanged": 0,
        "channels_hidden": 0,
        "channels_deleted": 0,
        "errors": 0,
        "failed": False,
        "message": "",
    }


def format_report(report, preview=False):
    title = "Live Sports preview" if preview else "Live Sports sync complete"
    if report.get("failed"):
        title = "Live Sports sync failed"
    lines = [
        title,
        "",
        "Events received: %s" % report["events_received"],
        "Eligible: %s" % report["eligible"],
        "Channels created: %s" % report["channels_created"],
        "Channels updated: %s" % report["channels_updated"],
        "Channels unchanged: %s" % report["channels_unchanged"],
        "Channels hidden: %s" % report["channels_hidden"],
        "Channels deleted: %s" % report["channels_deleted"],
        "Errors: %s" % report["errors"],
    ]
    if report.get("message"):
        lines.append(report["message"])
    return "\n".join(lines)


def playback_url(engine_url, event_id):
    return engine_url.rstrip("/") + "/api/dispatcharr/v1/events/%s/play.m3u8" % event_id


def group_name(settings, sport):
    prefix = (settings.get("group_prefix") or "Live Sports").strip()
    label = (sport or "Other").replace("_", " ").strip().title()
    return "%s / %s" % (prefix, label)


def sync(store, client, settings, now=None, dry_run=False):
    report = empty_report()
    now = now or datetime.now(timezone.utc)
    try:
        remote = client.events(settings.get("sports") or "all")
    except EngineError as err:
        report["failed"] = True
        report["errors"] = 1
        report["message"] = str(err)
        return report

    report["events_received"] = len(remote)
    remote_ids = set()
    engine_url = settings.get("engine_url") or "http://127.0.0.1:7000"

    for event in remote:
        event_id = event.get("id")
        if not event_id:
            continue
        remote_ids.add(event_id)
        action = decide(event, settings, now=now, missing=False)
        if action == "SKIP":
            continue
        report["eligible"] += 1
        existing = store.get_owned(event_id)
        if action == "HIDE":
            if existing and not existing.get("hidden"):
                if not dry_run:
                    store.hide(event_id)
                report["channels_hidden"] += 1
            elif existing:
                report["channels_unchanged"] += 1
            continue
        if action == "DELETE":
            if existing:
                if not dry_run:
                    store.delete_owned(event_id)
                report["channels_deleted"] += 1
            continue
        payload = _upsert_payload(event, settings, engine_url, now)
        if not existing:
            if not dry_run:
                store.create(payload)
            report["channels_created"] += 1
        elif _same_payload(existing, payload) and existing.get("has_epg", True) and existing.get("has_memberships", True):
            if not dry_run:
                store.touch(event_id, now)
            report["channels_unchanged"] += 1
        else:
            if not dry_run:
                store.update(event_id, payload)
            report["channels_updated"] += 1

    for owned in store.list_owned():
        event_id = owned["event_id"]
        if event_id in remote_ids:
            continue
        last_seen = parse_utc(owned.get("last_seen"))
        stub = {
            "id": event_id,
            "startTime": owned.get("start_time"),
            "estimatedEndTime": owned.get("end_time"),
        }
        action = decide(stub, settings, now=now, last_seen=last_seen, missing=True)
        if action == "KEEP":
            report["channels_unchanged"] += 1
            continue
        if action == "HIDE":
            if not owned.get("hidden"):
                if not dry_run:
                    store.hide(event_id)
                report["channels_hidden"] += 1
            else:
                report["channels_unchanged"] += 1
        elif action == "DELETE":
            if not dry_run:
                store.delete_owned(event_id)
            report["channels_deleted"] += 1

    return report


def _upsert_payload(event, settings, engine_url, now):
    event_id = event["id"]
    return {
        "event_id": event_id,
        "tvg_id": tvg_id_for(event_id),
        "name": event.get("title") or event_id,
        "sport": event.get("sport") or "other",
        "group": group_name(settings, event.get("sport")),
        "url": playback_url(engine_url, event_id),
        "start_time": event.get("startTime"),
        "end_time": event.get("estimatedEndTime"),
        "league": event.get("league") or "",
        "hidden": False,
        "last_seen": now.isoformat(),
        "channel_start": int(float(settings.get("channel_start") or 5000)),
        "profiles": [p.strip() for p in str(settings.get("profiles") or "").split(",") if p.strip()],
        "artwork": (event.get("artwork") or {}).get("logo") or "",
    }


def _norm_time(value):
    dt = parse_utc(value)
    if not dt:
        return ""
    return dt.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def _same_payload(existing, payload):
    if existing.get("name") != payload.get("name"):
        return False
    if existing.get("url") != payload.get("url"):
        return False
    if existing.get("group") != payload.get("group"):
        return False
    if (existing.get("league") or "") != (payload.get("league") or ""):
        return False
    if bool(existing.get("hidden")) != bool(payload.get("hidden")):
        return False
    if _norm_time(existing.get("start_time")) != _norm_time(payload.get("start_time")):
        return False
    if _norm_time(existing.get("end_time")) != _norm_time(payload.get("end_time")):
        return False
    return True

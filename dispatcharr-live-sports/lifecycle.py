from datetime import datetime, timedelta, timezone

STATES = ("DISCOVERED", "UPCOMING", "LIVE", "ENDED", "HIDDEN", "DELETED")


def parse_utc(value):
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def event_window(event, settings, now=None):
    now = now or datetime.now(timezone.utc)
    start = parse_utc(event.get("startTime"))
    end = parse_utc(event.get("estimatedEndTime"))
    if start and not end:
        end = start + timedelta(hours=3)
    create_before = timedelta(hours=float(settings.get("create_hours", 12)))
    hide_after = timedelta(hours=float(settings.get("hide_hours", 2)))
    delete_after = timedelta(hours=float(settings.get("delete_hours", 24)))
    grace = timedelta(minutes=float(settings.get("missing_grace_minutes", 30)))
    return {
        "now": now,
        "start": start,
        "end": end,
        "create_at": (start - create_before) if start else now,
        "hide_at": (end + hide_after) if end else None,
        "delete_at": (end + delete_after) if end else None,
        "grace": grace,
    }


def decide(event, settings, *, now=None, last_seen=None, missing=False):
    w = event_window(event, settings, now=now)
    now = w["now"]
    if missing:
        if last_seen and (now - last_seen) < w["grace"]:
            return "KEEP"
        if w["delete_at"] and now >= w["delete_at"]:
            return "DELETE"
        if w["hide_at"] and now >= w["hide_at"]:
            return "HIDE"
        return "KEEP"
    if w["delete_at"] and now >= w["delete_at"]:
        return "DELETE"
    if w["hide_at"] and now >= w["hide_at"]:
        return "HIDE"
    if w["create_at"] and now < w["create_at"]:
        return "SKIP"
    return "UPSERT"


def state_name(action, event, settings, now=None):
    w = event_window(event, settings, now=now)
    now = w["now"]
    if action == "DELETE":
        return "DELETED"
    if action == "HIDE":
        return "HIDDEN"
    if action == "SKIP":
        return "DISCOVERED"
    if not w["start"]:
        return "LIVE"
    if now < w["start"]:
        return "UPCOMING"
    if w["end"] and now >= w["end"]:
        return "ENDED"
    return "LIVE"

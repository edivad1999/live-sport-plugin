from contextlib import nullcontext
from datetime import datetime, timedelta, timezone

from lifecycle import parse_utc
from sync import EPG_SOURCE_NAME, PLUGIN_KEY, tvg_id_for


class MemoryStore:
    def __init__(self, channel_start=5000):
        self.owned = {}
        self.foreign = []
        self.next_number = channel_start
        self.numbers = []

    def atomic(self):
        return nullcontext()

    def list_owned(self):
        return [dict(row) for row in self.owned.values()]

    def get_owned(self, event_id):
        row = self.owned.get(event_id)
        return dict(row) if row else None

    def create(self, payload):
        number = self.next_number
        self.next_number += 1
        self.numbers.append(number)
        row = dict(payload)
        row["channel_number"] = number
        row["hidden"] = False
        row["has_epg"] = True
        row["has_memberships"] = True
        row["profiles"] = list(payload.get("profiles") or [])
        self.owned[payload["event_id"]] = row

    def update(self, event_id, payload):
        existing = self.owned[event_id]
        number = existing["channel_number"]
        row = dict(payload)
        row["channel_number"] = number
        row["hidden"] = False
        row["has_epg"] = True
        row["has_memberships"] = True
        row["profiles"] = list(payload.get("profiles") or [])
        self.owned[event_id] = row

    def touch(self, event_id, now):
        self.owned[event_id]["last_seen"] = now.isoformat()

    def hide(self, event_id):
        self.owned[event_id]["hidden"] = True

    def delete_owned(self, event_id):
        self.owned.pop(event_id, None)

    def add_foreign(self, name="User Channel", url="http://example/other.m3u8"):
        self.foreign.append({"name": name, "url": url, "owned": False})


class DjangoStore:
    def atomic(self):
        from django.db import transaction
        return transaction.atomic()

    def list_owned(self):
        return [self._row(stream, channel) for stream, channel in self._owned_pairs()]

    def get_owned(self, event_id):
        pair = self._pair_for(event_id)
        if not pair:
            return None
        return self._row(*pair)

    def create(self, payload):
        from apps.channels.models import (
            Channel,
            ChannelGroup,
            ChannelProfile,
            ChannelProfileMembership,
            ChannelStream,
            Stream,
        )

        now = parse_utc(payload.get("last_seen")) or datetime.now(timezone.utc)
        group, _ = ChannelGroup.objects.get_or_create(name=payload["group"])
        number = Channel.get_next_available_channel_number(starting_from=payload["channel_start"])
        channel = Channel.objects.create(
            name=payload["name"],
            tvg_id=payload["tvg_id"],
            channel_group=group,
            channel_number=number,
            hidden_from_output=False,
            auto_created=False,
        )
        stream = Stream.objects.create(
            name=payload["name"],
            url=payload["url"],
            tvg_id=payload["tvg_id"],
            channel_group=group,
            logo_url=payload.get("artwork") or None,
            last_seen=now,
            custom_properties={
                "managed_by": PLUGIN_KEY,
                "event_id": payload["event_id"],
                "api_version": 1,
            },
        )
        ChannelStream.objects.create(channel=channel, stream=stream, order=0)
        self._set_memberships(channel, payload.get("profiles") or [])
        self._upsert_epg(channel, payload)

    def update(self, event_id, payload):
        from apps.channels.models import ChannelGroup

        stream, channel = self._pair_for(event_id)
        group, _ = ChannelGroup.objects.get_or_create(name=payload["group"])
        channel.name = payload["name"]
        channel.tvg_id = payload["tvg_id"]
        channel.channel_group = group
        channel.hidden_from_output = False
        channel.save(update_fields=["name", "tvg_id", "channel_group", "hidden_from_output"])
        now = parse_utc(payload.get("last_seen")) or datetime.now(timezone.utc)
        props = dict(stream.custom_properties or {})
        props["managed_by"] = PLUGIN_KEY
        props["event_id"] = event_id
        props["api_version"] = 1
        stream.name = payload["name"]
        stream.url = payload["url"]
        stream.tvg_id = payload["tvg_id"]
        stream.channel_group = group
        stream.logo_url = payload.get("artwork") or stream.logo_url
        stream.last_seen = now
        stream.custom_properties = props
        stream.save()
        self._set_memberships(channel, payload.get("profiles") or [])
        self._upsert_epg(channel, payload)

    def touch(self, event_id, now):
        stream, _channel = self._pair_for(event_id)
        stream.last_seen = now
        stream.save(update_fields=["last_seen"])

    def hide(self, event_id):
        _stream, channel = self._pair_for(event_id)
        channel.hidden_from_output = True
        channel.save(update_fields=["hidden_from_output"])

    def delete_owned(self, event_id):
        from apps.epg.models import EPGData, ProgramData

        pair = self._pair_for(event_id)
        if not pair:
            return
        stream, channel = pair
        tvg = tvg_id_for(event_id)
        ProgramData.objects.filter(tvg_id=tvg).delete()
        EPGData.objects.filter(tvg_id=tvg, epg_source__name=EPG_SOURCE_NAME).delete()
        channel.delete()
        stream.delete()

    def _owned_pairs(self):
        from apps.channels.models import Stream

        for stream in Stream.objects.filter(tvg_id__startswith="live-sports:"):
            props = stream.custom_properties or {}
            if props.get("managed_by") != PLUGIN_KEY:
                continue
            channel = stream.channels.first()
            if channel is None:
                continue
            yield stream, channel

    def _pair_for(self, event_id):
        for stream, channel in self._owned_pairs():
            props = stream.custom_properties or {}
            if props.get("event_id") == event_id or channel.tvg_id == tvg_id_for(event_id):
                return stream, channel
        return None

    def _row(self, stream, channel):
        props = stream.custom_properties or {}
        epg = None
        if channel.epg_data_id:
            program = channel.epg_data.programs.order_by("start_time").first()
            if program:
                epg = program
        start = epg.start_time.isoformat() if epg else None
        end = epg.end_time.isoformat() if epg else None
        return {
            "event_id": props.get("event_id") or (channel.tvg_id or "")[len("live-sports:"):],
            "tvg_id": channel.tvg_id,
            "name": channel.name,
            "url": stream.url,
            "group": channel.channel_group.name if channel.channel_group_id else "",
            "start_time": start,
            "end_time": end,
            "league": (epg.description if epg else "") or "",
            "hidden": bool(channel.hidden_from_output),
            "last_seen": stream.last_seen.isoformat() if stream.last_seen else None,
            "channel_number": channel.channel_number,
            "has_epg": bool(channel.epg_data_id),
            "has_memberships": self._has_memberships(channel),
        }

    def _has_memberships(self, channel):
        from apps.channels.models import ChannelProfile, ChannelProfileMembership

        if not ChannelProfile.objects.exists():
            return True
        return ChannelProfileMembership.objects.filter(channel=channel).exists()

    def _set_memberships(self, channel, profile_names):
        from apps.channels.models import ChannelProfile, ChannelProfileMembership

        if profile_names:
            profiles = list(ChannelProfile.objects.filter(name__in=profile_names))
        else:
            profiles = list(ChannelProfile.objects.all())
        ChannelProfileMembership.objects.bulk_create(
            [
                ChannelProfileMembership(channel_profile=profile, channel=channel, enabled=True)
                for profile in profiles
            ],
            ignore_conflicts=True,
        )

    def _upsert_epg(self, channel, payload):
        from apps.epg.models import EPGData, EPGSource, ProgramData

        start = parse_utc(payload.get("start_time"))
        end = parse_utc(payload.get("end_time"))
        if not start:
            start = datetime.now(timezone.utc)
        if not end:
            end = start + timedelta(hours=3)
        source, _ = EPGSource.objects.get_or_create(
            name=EPG_SOURCE_NAME,
            defaults={"source_type": "dummy", "is_active": True},
        )
        epg, _ = EPGData.objects.get_or_create(
            tvg_id=payload["tvg_id"],
            epg_source=source,
            defaults={"name": payload["name"]},
        )
        if epg.name != payload["name"]:
            epg.name = payload["name"]
            epg.save(update_fields=["name"])
        channel.epg_data = epg
        channel.save(update_fields=["epg_data"])
        ProgramData.objects.filter(epg=epg).delete()
        ProgramData.objects.create(
            epg=epg,
            start_time=start,
            end_time=end,
            title=payload["name"],
            tvg_id=payload["tvg_id"],
            description=payload.get("league") or "",
        )

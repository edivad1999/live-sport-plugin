import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from client import EngineClient
from store import MemoryStore
from sync import sync

SETTINGS = {
    "engine_url": sys.argv[1],
    "sports": "all",
    "create_hours": 12,
    "hide_hours": 2,
    "delete_hours": 24,
    "missing_grace_minutes": 30,
    "channel_start": 5000,
    "group_prefix": "Live Sports",
    "profiles": "",
}


def main():
    client = EngineClient(SETTINGS["engine_url"])
    store = MemoryStore()
    first = sync(store, client, SETTINGS)
    second = sync(store, client, SETTINGS)
    print(json.dumps({
        "status": client.status(),
        "first": first,
        "second": second,
        "channels": store.list_owned(),
    }))


if __name__ == "__main__":
    main()

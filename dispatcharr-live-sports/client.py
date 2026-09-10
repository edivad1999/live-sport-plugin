import json
import urllib.error
import urllib.parse
import urllib.request


class EngineError(Exception):
    pass


class EngineClient:
    def __init__(self, base_url, token=None, timeout=8, max_bytes=2_000_000):
        self.base_url = base_url.rstrip("/")
        self.token = token or ""
        self.timeout = timeout
        self.max_bytes = max_bytes

    def _headers(self):
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        return headers

    def _get(self, path):
        req = urllib.request.Request(self.base_url + path, headers=self._headers(), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read(self.max_bytes + 1)
        except urllib.error.HTTPError as err:
            raise EngineError("engine HTTP %s" % err.code) from err
        except urllib.error.URLError as err:
            raise EngineError("engine unavailable") from err
        if len(raw) > self.max_bytes:
            raise EngineError("engine response too large")
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise EngineError("engine returned malformed JSON") from err

    def status(self):
        data = self._get("/api/dispatcharr/v1/status")
        if not isinstance(data, dict):
            raise EngineError("engine returned malformed JSON")
        return data

    def events(self, sports=None):
        path = "/api/dispatcharr/v1/events"
        if sports and sports.strip() and sports.strip().lower() != "all":
            path += "?sports=" + urllib.parse.quote(sports.strip())
        data = self._get(path)
        if not isinstance(data, dict) or "events" not in data:
            raise EngineError("engine returned malformed JSON")
        events = data["events"]
        if not isinstance(events, list):
            raise EngineError("engine returned malformed JSON")
        return events

#!/usr/bin/env bash
set -euo pipefail
BASE="${DISPATCHARR_URL:-http://127.0.0.1:9191}"
USER="${DISPATCHARR_USER:-dodadmin}"
PASS="${DISPATCHARR_PASS:-DodAdmin123!}"
PLUGIN_KEY="dispatcharr-live-sports"

say() { printf '%s\n' "$*"; }

wait_http() {
  local url="$1"
  local i
  for i in $(seq 1 90); do
    if curl -sf --connect-timeout 2 "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  say "timeout waiting for $url"
  return 1
}

say "wait for Dispatcharr"
wait_http "$BASE/" || true
# UI may 200/302; API setup is the real gate
for i in $(seq 1 90); do
  code=$(curl -s -o /tmp/dod-setup.json -w '%{http_code}' "$BASE/api/accounts/initialize-superuser/" || true)
  if [ "$code" = "200" ]; then
    break
  fi
  sleep 2
done
say "setup HTTP $code"
cat /tmp/dod-setup.json || true

python3 - <<PY
import json, os, urllib.request, urllib.error
base = os.environ.get("DISPATCHARR_URL", "http://127.0.0.1:9191")
user = os.environ.get("DISPATCHARR_USER", "dodadmin")
password = os.environ.get("DISPATCHARR_PASS", "DodAdmin123!")
plugin = "dispatcharr-live-sports"

def req(method, path, body=None, token=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return err.code, parsed

status, setup = req("GET", "/api/accounts/initialize-superuser/")
print("setup", status, setup)
if not setup.get("superuser_exists"):
    status, created = req("POST", "/api/accounts/initialize-superuser/", {
        "username": user,
        "password": password,
        "email": "dod@example.com",
    })
    print("create superuser", status, created)
    if status >= 400:
        raise SystemExit("superuser create failed")

status, tok = req("POST", "/api/accounts/token/", {"username": user, "password": password})
print("token", status, list(tok) if isinstance(tok, dict) else tok)
if status >= 400 or "access" not in tok:
    raise SystemExit("login failed")
token = tok["access"]

status, reload = req("POST", "/api/plugins/plugins/reload/", {}, token=token)
print("reload", status, reload)

status, listing = req("GET", "/api/plugins/plugins/", token=token)
plugins = listing.get("plugins") or []
keys = [p.get("key") for p in plugins]
print("plugins", status, keys)
if plugin not in keys:
    raise SystemExit("plugin not discovered")

status, enabled = req("POST", "/api/plugins/plugins/%s/enabled/" % plugin, {"enabled": True}, token=token)
print("enable", status, enabled)
if status >= 400:
    raise SystemExit("enable failed")

status, test = req("POST", "/api/plugins/plugins/%s/run/" % plugin, {"action": "test_engine", "params": {}}, token=token)
print("test_engine", status, test)
if status >= 400:
    raise SystemExit("test_engine failed")

status, preview = req("POST", "/api/plugins/plugins/%s/run/" % plugin, {"action": "preview_sync", "params": {}}, token=token)
print("preview_sync", status, preview)

status, first = req("POST", "/api/plugins/plugins/%s/run/" % plugin, {"action": "sync_now", "params": {}}, token=token, timeout=120)
print("sync_now_1", status, first)
if status >= 400:
    raise SystemExit("sync_now failed")

status, second = req("POST", "/api/plugins/plugins/%s/run/" % plugin, {"action": "sync_now", "params": {}}, token=token, timeout=120)
print("sync_now_2", status, second)

status, channels = req("GET", "/api/channels/channels/?page_size=200", token=token)
print("channels_http", status)
results = channels.get("results") or channels.get("channels") or []
if isinstance(channels, list):
    results = channels
owned = [c for c in results if str(c.get("tvg_id") or "").startswith("live-sports:")]
print("owned_count", len(owned))
if owned:
    print("owned_sample", {k: owned[0].get(k) for k in ("name", "tvg_id", "channel_number", "hidden_from_output")})
    streams = owned[0].get("streams") or []
    print("streams", streams[:2] if streams else "none-on-channel-payload")

status, epg = req("GET", "/api/epg/epgs/?page_size=200", token=token)
print("epg_http", status, list(epg)[:8] if isinstance(epg, dict) else type(epg))

open("/tmp/dod-verify.json", "w").write(json.dumps({
    "test_engine": test,
    "preview": preview,
    "first": first,
    "second": second,
    "owned_count": len(owned),
    "owned": owned[:3],
}, indent=2))
print("wrote /tmp/dod-verify.json")
PY

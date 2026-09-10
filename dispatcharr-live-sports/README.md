# Live Sports for Dispatcharr

This plugin turns sports events from the companion engine into native Dispatcharr channels and EPG rows. Playback URLs stay on the engine and resolve just in time. Dispatcharr still owns lineups, profiles, and client output.

## What you need

1. The Live Sports engine running where Dispatcharr can reach it. Default is `http://127.0.0.1:7000`.
2. This folder installed as a Dispatcharr plugin.

The plugin never asks for a Dispatcharr URL, username, or password. It runs inside Dispatcharr and uses the ORM.

## Install

1. Download `dispatcharr-live-sports.zip` from a GitHub release of [edivad1999/live-sport-plugin](https://github.com/edivad1999/live-sport-plugin).
2. In Dispatcharr, open Plugins and import the ZIP.
3. Enable the plugin.
4. Set Engine URL if the engine is not on `http://127.0.0.1:7000`.
5. Click Test Engine, then Sync Now.

Build the ZIP from this repository:

```bash
./scripts/package-dispatcharr-plugin.sh
```

On a Gluetun host, run the engine in the VPN network namespace and leave port 7000 unpublished. Dispatcharr in that same namespace can use the default engine URL. See `docker-compose.dispatcharr.yml`.

## Engine API

The plugin talks only to:

```text
GET /api/dispatcharr/v1/status
GET /api/dispatcharr/v1/events
GET /api/dispatcharr/v1/events/:id/play.m3u8
```

Each channel stream URL is the stable play path, not a provider CDN URL.

## Lifecycle

| Window | Default |
| --- | --- |
| Create | 12 hours before start |
| Hide | 2 hours after estimated end |
| Delete | 24 hours after estimated end |
| Missing grace | 30 minutes |

A temporary empty catalogue does not delete channels. Engine failures leave existing channels unchanged.

## Ownership

Owned channels use `tvg_id = live-sports:<event-id>`. Owned streams set `custom_properties.managed_by` to `dispatcharr-live-sports`. Cleanup never touches other channels.

## License

MIT. Same license as the engine.

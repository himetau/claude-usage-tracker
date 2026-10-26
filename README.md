# claude-usage-tracker

Track how much of a shared Claude subscription's 5-hour and weekly limits each person uses.

- **`server/`**: a tiny Go server (scratch image, ~9 MB) that appends usage samples from each person to a JSON-lines file. Image: `ghcr.io/himetau/claude-usage-tracker`, built for amd64 and arm64 on every push to `main`.
- **`plugins/usage-tracker/`**: a Claude Code plugin. It sends each turn's token counts and the account's limit readings to the server, and adds `/usage-report`, which estimates each person's share of the current windows plus untracked use (claude.ai chat, mobile).

## Server

Configured with environment variables:

| Variable | Default | |
|---|---|---|
| `ACCESS_TOKENS` | (required) | Comma-separated bearer tokens, one per person (`openssl rand -hex 32`) |
| `LISTEN_ADDR` | `:8080` | |
| `DATA_FILE` | `/data/usage.jsonl` | |
| `MAX_BODY_BYTES` | `65536` | |

API (all `/v1/usage` calls need `Authorization: Bearer <token>`):

- `POST /v1/usage`: JSON object body, stored as `{"received_at","client","data"}`, where `client` is the first 8 hex chars of the token's SHA-256
- `GET /v1/usage`: the whole file as NDJSON
- `GET /healthz`

Deploy with [`server/docker-compose.yml`](server/docker-compose.yml): put `ACCESS_TOKENS=...` in a `.env` next to it and run `docker compose up -d`. The port binds to localhost only; put a TLS reverse proxy in front.

## Plugin

At the prompt of a terminal session:

```
/plugin install usage-tracker --marketplace himetau/claude-usage-tracker
```

From a shell:

```
claude plugin install usage-tracker --marketplace himetau/claude-usage-tracker
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `himetau/claude-usage-tracker`, then Add plugin.

Then set `server_url`, `access_token` (your own token) and optionally `display_name`. See [the plugin README](plugins/usage-tracker/README.md) for how the split is estimated.

# usage-tracker

Tracks how much of a shared Claude subscription's 5-hour and weekly limits each person uses.

Each person runs this plugin with their own access token for the companion `usage-server`. After every turn it sends that turn's token counts (model, input, output, cache) together with the account's current limit readings, and it also sends a reading whenever a limit moves by a whole point. Samples are queued locally and retried if the server is unreachable.

`/usage-report` fetches everyone's samples and shows, for the current 5-hour and weekly windows, each person's estimated share of the account percentage plus "untracked" usage (claude.ai chat, mobile, anyone not running the plugin). The share is calibrated from stretches where only one person was active; until there are a few points of such data it falls back to splitting by token share.

The status line entry shows `5h N% · 7d N%`, with `sync ⚠` when the server can't be reached.

## Setup

Set in `/config` (or when installing): `server_url`, `access_token` (one of the server's `ACCESS_TOKENS`, a different one per person) and optionally `display_name`.

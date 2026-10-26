# usage-tracker

Tracks how much of a shared Claude subscription's 5-hour and weekly limits each person uses.

Each person runs this plugin with their own access token for the companion `usage-server`. After every turn it sends that turn's token counts (model, input, output, cache) together with the account's current limit readings, and it also sends a reading whenever a limit moves by a whole point. Samples are queued locally and retried if the server is unreachable.

`/usage-report` fetches everyone's samples and shows, for the current 5-hour and weekly windows, how much of the account percentage each person used. Every rise in the limit between two readings is credited to whoever was using Claude Code at the time (split by cost-weighted tokens when several were); a rise while nobody tracked was active counts as untracked (claude.ai chat, mobile, anyone not running the plugin). Whatever was already used when tracking began is shown as "before tracking started".

The status line entry shows `5h N% · 7d N%`, with `sync ⚠` when the server can't be reached.

## Setup

Set in `/config` (or when installing): `server_url`, `access_token` (one of the server's `ACCESS_TOKENS`, a different one per person) and optionally `display_name`.

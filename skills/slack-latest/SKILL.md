---
name: slack-latest
description: Gather recent Slack messages, read threads, and send replies. Use when the user asks about Slack activity or wants to interact with Slack.
---

# Slack: gather recent messages, read threads, reply

`slack.py` is a self-contained Python script (no dependencies beyond
the standard library) at `{baseDir}/slack.py`.

## Authentication setup (one-time)

Requires browser tokens from a Slack session.

1. Open Slack in your browser (Chrome, Chromium, Firefox, etc.)
2. Open DevTools (F12) → **Network** tab
3. Reload the page
4. Find any request to `*.slack.com` (e.g. `api/client.boot`)
5. Right-click → **Copy as cURL**
6. Run:

```bash
pbpaste | python3 {baseDir}/slack.py auth
# or paste directly:
python3 {baseDir}/slack.py auth <<'CURL'
curl 'https://WORKSPACE.slack.com/api/...' -H '...' -b '...' --data-raw '...'
CURL
```

Credentials are stored at `$XDG_CONFIG_HOME/skills/slack-latest/credentials.json`
(typically `~/.config/skills/slack-latest/credentials.json`).

**Token lifetime:** Browser tokens (`xoxc`/`xoxd`) expire when you log
out or when Slack rotates the session. If commands start failing with
auth errors, re-run the setup.

To verify credentials work:

```bash
python3 {baseDir}/slack.py auth-test
```

## Gather recent messages

Scans all conversations (channels, DMs, group DMs) and collects human
messages from the last N days, with thread replies expanded inline.

```bash
python3 {baseDir}/slack.py gather --days 3 --out ~/tmp/slack-recent.json
```

Output: JSON array grouped by channel (most recently active first).
Indented by default; use `--compact` for single-line JSON.

```json
[
  {
    "channel": "#general", "_id": "C0123456789",
    "messages": [
      {
        "from": "Dan Abnormal", "at": "2026-02-08 12:18",
        "text": "Interesting discussion on...",
        "_uid": "U0123456789", "_ts": "1700000000.000001",
        "reactions": ["eyes(2)"],
        "replies": [
          {"from": "Ogdred Weary", "at": "2026-02-08 12:20", "text": "Agreed, ..."}
        ]
      }
    ]
  }
]
```

- Messages within each channel are sorted oldest-first (narrative order)
- Thread replies expanded inline under `replies`
- `older_replies: N` when replies exist but fall outside the time window
- `in_thread: true` marks messages broadcast from a thread
- `_id`, `_uid`, `_ts` fields only present with `--include-ids`

### Options

- `--days N` — time window (default: 3)
- `--max-text N` — truncate message text in chars (default: 500)
- `--include-ids` — add `_id`, `_uid`, `_ts` for follow-up API calls
- `--compact` — single-line JSON (saves ~25% size)

## Read a single thread

```bash
python3 {baseDir}/slack.py thread --channel C0123456789 --ts 1700000000.000001
```

Returns the full thread as JSON (all replies, with author names resolved).

## Send a message

```bash
# Send to a channel
python3 {baseDir}/slack.py send --channel C0123456789 --text "Hello"

# Reply in a thread
python3 {baseDir}/slack.py send --channel C0123456789 --thread-ts 1700000000.000001 --text "Got it"
```

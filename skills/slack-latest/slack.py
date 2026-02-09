#!/usr/bin/env python3
"""Slack CLI for AI agents: gather recent messages, read threads, send replies.

Self-contained — no dependencies beyond the Python standard library.

Subcommands:
    auth        Parse a cURL command from stdin to extract and store tokens
    auth-test   Verify stored credentials
    gather      Collect recent messages across all conversations
    thread      Read a single thread
    send        Send or reply to a message
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _xdg_config_home() -> Path:
    """Return XDG_CONFIG_HOME, defaulting to ~/.config."""
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))


CRED_PATH = _xdg_config_home() / "skills" / "slack-latest" / "credentials.json"


# ---------------------------------------------------------------------------
# Slack API helpers
# ---------------------------------------------------------------------------

def load_credentials() -> tuple[str, str, str]:
    """Return (workspace_url, xoxc_token, xoxd_cookie)."""
    if not CRED_PATH.exists():
        print(f"No credentials found at {CRED_PATH}", file=sys.stderr)
        print("Run: python3 slack.py auth", file=sys.stderr)
        sys.exit(1)
    creds = json.loads(CRED_PATH.read_text())
    return creds["workspace_url"], creds["token"], creds["cookie"]


def slack_api(workspace_url: str, token: str, cookie: str,
              method: str, params: dict | None = None) -> dict:
    """Call a Slack API method with browser-style auth."""
    url = f"{workspace_url.rstrip('/')}/api/{method}"
    body = urllib.parse.urlencode({"token": token, **(params or {})}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Cookie": f"d={urllib.parse.quote(cookie, safe='')}",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://app.slack.com",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
    if not result.get("ok"):
        err = result.get("error", "unknown")
        if err == "ratelimited":
            delay = int(resp.headers.get("Retry-After", "5"))
            time.sleep(min(delay, 30))
            return slack_api(workspace_url, token, cookie, method, params)
        raise RuntimeError(f"Slack API {method}: {err}")
    return result


def paginate(workspace_url: str, token: str, cookie: str,
             method: str, key: str, params: dict | None = None) -> list[dict]:
    """Paginate a cursor-based Slack API method."""
    results: list[dict] = []
    cursor = None
    while True:
        p = {"limit": "200", **(params or {})}
        if cursor:
            p["cursor"] = cursor
        resp = slack_api(workspace_url, token, cookie, method, p)
        results.extend(resp.get(key, []))
        cursor = (resp.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            break
    return results


# ---------------------------------------------------------------------------
# User map
# ---------------------------------------------------------------------------

def build_user_map(workspace_url: str, token: str, cookie: str) -> dict[str, str]:
    """Build user_id -> display_name map."""
    users = paginate(workspace_url, token, cookie, "users.list", "members")
    umap: dict[str, str] = {}
    for u in users:
        uid = u.get("id", "")
        if uid == "USLACKBOT":
            continue
        profile = u.get("profile", {})
        name = (
            profile.get("display_name_normalized")
            or profile.get("real_name_normalized")
            or u.get("real_name")
            or u.get("name", uid)
        )
        umap[uid] = name
    return umap


def resolve_mentions(text: str, user_map: dict[str, str]) -> str:
    """Replace <@U123> with @DisplayName."""
    return re.sub(
        r"<@(U[A-Z0-9]+)>",
        lambda m: f"@{user_map.get(m.group(1), m.group(1))}",
        text,
    )


# ---------------------------------------------------------------------------
# Channel naming
# ---------------------------------------------------------------------------

def channel_display_name(ch: dict, user_map: dict[str, str]) -> str:
    """Readable name for a channel/DM/group DM."""
    if ch.get("is_im"):
        other = ch.get("user", "")
        return f"DM:{user_map.get(other, other)}"
    if ch.get("is_mpim"):
        name = ch.get("name", "")
        if name.startswith("mpdm-"):
            handles = name[5:].rsplit("-", 1)[0].split("--")
            return f"GroupDM:{','.join(handles)}"
        return f"GroupDM:{ch.get('id')}"
    return f"#{ch.get('name', ch.get('id', '?'))}"


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------

SKIP_SUBTYPES = {
    "bot_message", "channel_join", "channel_leave",
    "channel_topic", "channel_purpose", "channel_name",
    "group_join", "group_leave",
}


def is_bot_noise(msg: dict) -> bool:
    """Return True if a message is bot/automated noise."""
    if msg.get("subtype", "") in SKIP_SUBTYPES:
        return True
    if msg.get("bot_id") and not msg.get("user"):
        return True
    return False


def format_message(msg: dict, user_map: dict[str, str],
                   max_text: int = 500, include_ids: bool = False) -> dict:
    """Format a single Slack message into a compact dict."""
    uid = msg.get("user", "")
    ts_float = float(msg.get("ts", 0))
    dt = datetime.fromtimestamp(ts_float, tz=timezone.utc)
    text = resolve_mentions(msg.get("text", ""), user_map)
    if len(text) > max_text:
        text = text[:max_text] + "…"

    entry: dict = {
        "from": user_map.get(uid, uid),
        "at": dt.strftime("%Y-%m-%d %H:%M"),
        "text": text,
    }

    if include_ids:
        entry["_uid"] = uid
        entry["_ts"] = msg.get("ts")

    if msg.get("reactions"):
        entry["reactions"] = [
            f"{r['name']}({r['count']})" for r in msg["reactions"]
        ]

    return entry


# ---------------------------------------------------------------------------
# Subcommand: auth
# ---------------------------------------------------------------------------

def cmd_auth(args: argparse.Namespace) -> None:
    """Parse a cURL command from stdin to extract workspace, token, cookie."""
    if sys.stdin.isatty():
        print("Paste a cURL command copied from a Slack API request,",
              file=sys.stderr)
        print("then press Ctrl-D (EOF):\n", file=sys.stderr)
    curl_text = sys.stdin.read()

    if not curl_text.strip():
        print("No input received.", file=sys.stderr)
        sys.exit(1)

    # Extract workspace URL
    url_match = re.search(r"https?://([a-zA-Z0-9-]+\.slack\.com)", curl_text)
    if not url_match:
        print("Could not find a *.slack.com URL in the input.",
              file=sys.stderr)
        sys.exit(1)
    workspace_url = f"https://{url_match.group(1)}"

    # Extract xoxd cookie
    cookie = None
    m = re.search(r"xoxd-[A-Za-z0-9%/+=]+", curl_text)
    if m:
        cookie = urllib.parse.unquote(m.group(0))
    if not cookie:
        print("Could not find xoxd cookie in the input.", file=sys.stderr)
        sys.exit(1)

    # Extract xoxc token
    token = None
    m = re.search(r"xoxc-[A-Za-z0-9-]+", curl_text)
    if m:
        token = m.group(0)
    if not token:
        print("Could not find xoxc token in the input.", file=sys.stderr)
        sys.exit(1)

    CRED_PATH.parent.mkdir(parents=True, exist_ok=True)
    CRED_PATH.write_text(json.dumps({
        "workspace_url": workspace_url,
        "token": token,
        "cookie": cookie,
    }, indent=2))
    CRED_PATH.chmod(0o600)

    print(f"Saved credentials for {workspace_url} to {CRED_PATH}")


# ---------------------------------------------------------------------------
# Subcommand: auth-test
# ---------------------------------------------------------------------------

def cmd_auth_test(args: argparse.Namespace) -> None:
    """Verify stored credentials."""
    workspace_url, token, cookie = load_credentials()
    result = slack_api(workspace_url, token, cookie, "auth.test")
    print(json.dumps({
        "ok": True,
        "workspace": result.get("team"),
        "user": result.get("user"),
        "user_id": result.get("user_id"),
        "url": result.get("url"),
    }, indent=2))


# ---------------------------------------------------------------------------
# Subcommand: gather
# ---------------------------------------------------------------------------

def cmd_gather(args: argparse.Namespace) -> None:
    """Gather recent messages across all conversations."""
    workspace_url, token, cookie = load_credentials()
    oldest = datetime.now(timezone.utc) - timedelta(days=args.days)
    oldest_ts = str(oldest.timestamp())
    max_text = args.max_text
    include_ids = args.include_ids

    log = lambda *a, **kw: print(*a, **kw, file=sys.stderr, flush=True)

    log("Building user map...")
    user_map = build_user_map(workspace_url, token, cookie)
    log(f"  {len(user_map)} users")

    log("Discovering conversations...")
    conversations = paginate(
        workspace_url, token, cookie, "users.conversations", "channels",
        params={"types": "public_channel,private_channel,mpim,im",
                "exclude_archived": "true"},
    )
    log(f"  {len(conversations)} conversations")

    # Collect messages grouped by channel
    channel_groups: dict[str, dict] = {}  # ch_name -> {id, messages}
    skipped = 0

    for i, ch in enumerate(conversations):
        ch_id = ch["id"]
        ch_name = channel_display_name(ch, user_map)

        try:
            resp = slack_api(workspace_url, token, cookie,
                             "conversations.history",
                             {"channel": ch_id, "oldest": oldest_ts,
                              "limit": "200"})
        except RuntimeError as e:
            if "not_in_channel" in str(e) or "channel_not_found" in str(e):
                continue
            raise

        raw_msgs = resp.get("messages", [])
        ch_messages = []

        for msg in raw_msgs:
            if is_bot_noise(msg):
                skipped += 1
                continue

            entry = format_message(msg, user_map, max_text, include_ids)

            if msg.get("thread_ts") and msg.get("thread_ts") != msg.get("ts"):
                entry["in_thread"] = True

            # Expand threads: only for root messages that have replies
            reply_count = msg.get("reply_count", 0)
            is_thread_root = msg.get("ts") == msg.get("thread_ts",
                                                       msg.get("ts"))
            if reply_count > 0 and is_thread_root:
                try:
                    thread_resp = slack_api(
                        workspace_url, token, cookie,
                        "conversations.replies",
                        {"channel": ch_id, "ts": msg["ts"],
                         "oldest": oldest_ts, "limit": "100"})
                    # First message in replies is the root — skip it
                    raw_replies = thread_resp.get("messages", [])[1:]
                    reply_entries = [
                        format_message(r, user_map, max_text, include_ids)
                        for r in raw_replies if not is_bot_noise(r)
                    ]
                    if reply_entries:
                        entry["replies"] = reply_entries
                    elif reply_count > 0:
                        # Replies exist but are outside our time window
                        entry["older_replies"] = reply_count
                except RuntimeError:
                    entry["older_replies"] = reply_count

            ch_messages.append(entry)

        if ch_messages:
            # Sort messages within channel oldest-first (narrative order)
            ch_messages.sort(key=lambda m: m["at"])
            channel_groups[ch_name] = {
                "messages": ch_messages,
            }
            if include_ids:
                channel_groups[ch_name]["_id"] = ch_id

        if (i + 1) % 20 == 0:
            log(f"  scanned {i+1}/{len(conversations)}...")

    # Build output: sorted by most recent activity per channel
    output: list[dict] = []
    for ch_name, data in sorted(
        channel_groups.items(),
        key=lambda kv: kv[1]["messages"][-1]["at"],
        reverse=True,
    ):
        entry: dict = {"channel": ch_name, "messages": data["messages"]}
        if include_ids and "_id" in data:
            entry["_id"] = data["_id"]
        output.append(entry)

    out_path = Path(args.out).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if args.compact:
        out_text = json.dumps(output, ensure_ascii=False)
    else:
        out_text = json.dumps(output, indent=2, ensure_ascii=False)

    out_path.write_text(out_text)

    total_msgs = sum(len(ch["messages"]) for ch in output)
    total_replies = sum(
        len(m.get("replies", []))
        for ch in output for m in ch["messages"]
    )
    log(f"\nDone: {total_msgs} messages + {total_replies} thread replies "
        f"in {len(output)} channels ({skipped} bot/noise skipped)")
    log(f"Output: {out_path} ({len(out_text)} bytes)")


# ---------------------------------------------------------------------------
# Subcommand: thread
# ---------------------------------------------------------------------------

def cmd_thread(args: argparse.Namespace) -> None:
    """Read a single thread."""
    workspace_url, token, cookie = load_credentials()
    user_map = build_user_map(workspace_url, token, cookie)

    resp = slack_api(workspace_url, token, cookie,
                     "conversations.replies",
                     {"channel": args.channel, "ts": args.ts, "limit": "200"})

    messages = [
        format_message(m, user_map, include_ids=args.include_ids)
        for m in resp.get("messages", [])
        if not is_bot_noise(m)
    ]

    print(json.dumps(messages, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Subcommand: send
# ---------------------------------------------------------------------------

def cmd_send(args: argparse.Namespace) -> None:
    """Send a message or reply in a thread."""
    workspace_url, token, cookie = load_credentials()

    params: dict = {"channel": args.channel, "text": args.text}
    if args.thread_ts:
        params["thread_ts"] = args.thread_ts

    result = slack_api(workspace_url, token, cookie, "chat.postMessage",
                       params)
    ts = result.get("ts", "?")
    print(json.dumps({"ok": True, "ts": ts}, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Slack CLI for AI agents")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("auth",
                   help="Parse a cURL command from stdin to store credentials")

    sub.add_parser("auth-test",
                   help="Verify stored credentials")

    p_gather = sub.add_parser(
        "gather",
        help="Gather recent messages from all conversations")
    p_gather.add_argument("--days", type=int, default=3,
                          help="How many days back (default: 3)")
    p_gather.add_argument("--out", default="~/tmp/slack-recent.json",
                          help="Output file path")
    p_gather.add_argument("--max-text", type=int, default=500,
                          help="Max chars per message text (default: 500)")
    p_gather.add_argument("--include-ids", action="store_true",
                          help="Include _uid, _ts, _id fields for API calls")
    p_gather.add_argument("--compact", action="store_true",
                          help="Single-line JSON (default: indented)")

    p_thread = sub.add_parser("thread",
                              help="Read a single thread")
    p_thread.add_argument("--channel", required=True,
                          help="Channel ID (e.g. C0123456789)")
    p_thread.add_argument("--ts", required=True,
                          help="Thread root timestamp")
    p_thread.add_argument("--include-ids", action="store_true",
                          help="Include _uid, _ts fields")

    p_send = sub.add_parser("send",
                            help="Send a message or reply")
    p_send.add_argument("--channel", required=True,
                        help="Channel ID")
    p_send.add_argument("--text", required=True,
                        help="Message text")
    p_send.add_argument("--thread-ts",
                        help="Thread timestamp to reply to (optional)")

    args = parser.parse_args()

    dispatch = {
        "auth": cmd_auth,
        "auth-test": cmd_auth_test,
        "gather": cmd_gather,
        "thread": cmd_thread,
        "send": cmd_send,
    }
    dispatch[args.command](args)


if __name__ == "__main__":
    main()

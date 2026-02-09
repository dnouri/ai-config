#!/usr/bin/env python3
"""Extract patterns from pi coding agent session files.

Session files are JSONL in ~/.pi/agent/sessions/<mangled-cwd>/.
Each line is a JSON object with a "type" field:
  - "session": session metadata (id, cwd, timestamp)
  - "message": user/assistant messages with content blocks
  - "compaction": compacted conversation summary
  - "model_change", "thinking_level_change", "session_info": metadata

Message content blocks (role=assistant) have types:
  - "text": prose from the assistant
  - "toolCall": tool invocation with name and arguments

Messages with role=toolResult contain tool output:
  - "isError": true/false — whether the tool call failed
  - "toolName": which tool produced the result
  - "content": [{type: "text", text: "..."}] — the output

Usage examples:
  # Overview: session count, tool usage
  extract.py --summary

  # Frequency tables
  extract.py --commands --stats          # most common bash commands
  extract.py --reads --stats             # most read files
  extract.py --failures --stats          # most common tool failures

  # Deep-dive with regex filter
  extract.py --commands --match "git "
  extract.py --failures --match "syntax|paren"

  # Narrative view: see what happened in order
  extract.py --sequences                 # all sessions
  extract.py --sequences --match "FAIL"  # only show around failures

  # Session summaries from compaction
  extract.py --compactions

  # Explicit sessions directory and count
  extract.py --sessions-dir ~/.pi/agent/sessions/--my-project--/ --commands --last 20
"""

import argparse
import json
import glob
import os
import re
import sys
from collections import Counter
from pathlib import Path




def find_sessions_dir(cwd: str | None = None) -> str | None:
    """Auto-discover sessions directory from CWD."""
    cwd = cwd or os.getcwd()
    mangled = "--" + cwd.strip("/").replace("/", "-") + "--"
    sessions_base = os.path.expanduser("~/.pi/agent/sessions")
    candidate = os.path.join(sessions_base, mangled)
    if os.path.isdir(candidate):
        return candidate
    return None


def get_session_files(sessions_dir: str, last: int) -> list[str]:
    """Get the N most recent session files."""
    files = sorted(
        glob.glob(os.path.join(sessions_dir, "*.jsonl")),
        key=os.path.getmtime,
        reverse=True,
    )
    return files[:last]


def session_label(filepath: str) -> str:
    """Short unique label like '01-30T17:56_21f5' from filename.

    Input: 2026-01-30T17-56-34-023Z_21f5ff0a-f0f3-4639-...jsonl
    Output: 01-30T17:56_21f5
    """
    name = os.path.basename(filepath)
    try:
        month_day = name[5:10]  # "01-30"
        hour = name[11:13]
        minute = name[14:16]
        uuid4 = name.split("_")[1][:4] if "_" in name else "????"
        return f"{month_day}T{hour}:{minute}_{uuid4}"
    except (IndexError, ValueError):
        return name[:20]


def build_session_index(files: list[str]) -> dict[str, str]:
    """Map filepath → short label. Ensures labels are unique."""
    index: dict[str, str] = {}
    for fpath in files:
        index[fpath] = session_label(fpath)
    return index


def clean_text(text: str) -> str:
    """Strip ANSI codes and collapse box-drawing noise."""
    # Strip ANSI escape sequences
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    # Collapse runs of box-drawing characters (─━═│etc.)
    text = re.sub(r"[─━═│┌┐└┘├┤┬┴┼]{3,}", "...", text)
    # Collapse multiple spaces
    text = re.sub(r"  +", " ", text)
    return text.strip()


def iter_lines(filepath: str):
    """Yield (line_number, parsed_object) from a session file."""
    with open(filepath) as f:
        for lineno, line in enumerate(f, 1):
            try:
                yield lineno, json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue


def extract_commands(filepath: str):
    """Yield (command, lineno) for bash tool calls."""
    for lineno, obj in iter_lines(filepath):
        if obj.get("type") != "message":
            continue
        msg = obj["message"]
        if msg.get("role") != "assistant":
            continue
        for block in msg.get("content", []):
            if (isinstance(block, dict)
                    and block.get("type") == "toolCall"
                    and block.get("name", "").lower() == "bash"):
                cmd = block.get("arguments", {}).get("command", "")
                if cmd:
                    yield cmd, lineno


def extract_reads(filepath: str):
    """Yield (path, lineno) for read tool calls."""
    for lineno, obj in iter_lines(filepath):
        if obj.get("type") != "message":
            continue
        msg = obj["message"]
        if msg.get("role") != "assistant":
            continue
        for block in msg.get("content", []):
            if (isinstance(block, dict)
                    and block.get("type") == "toolCall"
                    and block.get("name", "").lower() == "read"):
                path = block.get("arguments", {}).get("path", "")
                if path:
                    yield path, lineno


FAIL_PATTERN = re.compile(
    r"FAIL|✗|error:|Error:|Error |ENOENT|"
    r"exit code [^0]|command not found|not found|"
    r"Permission denied|syntax error|"
    r"Traceback|Exception:|ModuleNotFoundError|"
    r"Cannot find|Unmatched|undefined|"
    r"timed out|INSUFFICIENT|NOT_FOUND",
    re.IGNORECASE,
)


def extract_failures(filepath: str):
    """Yield (description, lineno) for tool results that failed.

    Two confidence tiers:
    - [ERROR]: isError=true — ground truth from tool exit code
    - [output]: error patterns in output text — heuristic, may have
      false positives (e.g. "0 failed" or test named "Error type")

    For read tool: only isError (file content naturally matches patterns).
    """
    for lineno, obj in iter_lines(filepath):
        if obj.get("type") != "message":
            continue
        msg = obj["message"]
        if msg.get("role") != "toolResult":
            continue
        is_error = msg.get("isError", False)
        tool = msg.get("toolName", "?")
        text = ""
        for block in msg.get("content", []):
            if isinstance(block, dict):
                text = block.get("text", "")
        snippet = clean_text(text[:200])
        if is_error:
            yield f"[ERROR] [{tool}] {snippet}", lineno
        elif tool != "read" and FAIL_PATTERN.search(text[:500]):
            yield f"[output] [{tool}] {snippet}", lineno


def extract_compactions(filepath: str):
    """Yield (summary, lineno) for compaction entries."""
    for lineno, obj in iter_lines(filepath):
        if obj.get("type") == "compaction":
            summary = obj.get("summary", "")
            yield summary, lineno


def extract_sequences(filepath: str):
    """Yield (lineno, kind, description) for narrative sequence view."""
    for lineno, obj in iter_lines(filepath):
        if obj.get("type") == "compaction":
            summary = obj.get("summary", "")[:150].replace("\n", " ")
            yield lineno, "COMPACT", summary
            continue

        if obj.get("type") != "message":
            continue

        msg = obj["message"]
        role = msg.get("role")

        if role == "user":
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("type") == "text":
                    t = block.get("text", "").strip()
                    if t and len(t) > 5:
                        yield lineno, "USER", t[:150].replace("\n", " ")

        elif role == "assistant":
            for block in msg.get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "toolCall":
                    name = block.get("name", "")
                    args = block.get("arguments", {})
                    if name == "bash":
                        yield lineno, "BASH", args.get("command", "")[:150]
                    elif name == "edit":
                        path = args.get("path", "").split("/")[-1]
                        yield lineno, "EDIT", path
                    elif name == "write":
                        path = args.get("path", "").split("/")[-1]
                        yield lineno, "WRITE", path
                    elif name == "read":
                        path = args.get("path", "").split("/")[-1]
                        yield lineno, "READ", path
                    else:
                        yield lineno, name.upper()[:8], str(args)[:100]

        elif role == "toolResult":
            is_error = msg.get("isError", False)
            if is_error:
                tool = msg.get("toolName", "?")
                text = ""
                for block in msg.get("content", []):
                    if isinstance(block, dict):
                        text = block.get("text", "")
                snippet = clean_text(text[:120])
                yield lineno, "!! ERROR", f"[{tool}] {snippet}"


def match_filter(items, pattern: str | None):
    """Filter (value, lineno) pairs by regex on value."""
    if not pattern:
        yield from items
        return
    regex = re.compile(pattern, re.IGNORECASE)
    for item in items:
        if regex.search(item[0]):
            yield item


def print_stats(items_by_session: dict[str, list[tuple[str, int]]],
                top: int = 30):
    """Print frequency table as markdown cards."""
    total_counter: Counter = Counter()
    session_counter: Counter = Counter()
    example_lines: dict[str, list[str]] = {}

    for session_name, items in items_by_session.items():
        seen: set[str] = set()
        for value, lineno in items:
            cleaned = clean_text(value)
            normalized = re.sub(r"\s+", " ", cleaned)
            key = normalized[:120]
            total_counter[key] += 1
            if key not in seen:
                session_counter[key] += 1
                seen.add(key)
            example_lines.setdefault(key, []).append(
                f"`{session_name}:L{lineno}`"
            )

    total_items = sum(total_counter.values())
    total_sessions = len(items_by_session)
    print(f"### {total_items} items across {total_sessions} sessions\n")

    for rank, (key, count) in enumerate(
        total_counter.most_common(top), 1
    ):
        sessions = session_counter[key]
        refs = example_lines[key][:3]
        print(f"**#{rank}** — **{count}×** across {sessions} session(s)")
        print(f"`{key}`")
        print(f"e.g. {', '.join(refs)}")
        print()


def print_items(items_by_session: dict[str, list[tuple[str, int]]]):
    """Print items grouped by session with line references."""
    for session_name, items in items_by_session.items():
        if items:
            print(f"\n## {session_name} ({len(items)} items)\n")
            for value, lineno in items:
                cleaned = clean_text(value)
                print(f"- `L{lineno}` {cleaned[:160]}")


def print_sequences(sequences_by_session: dict[str, list[tuple[int, str, str]]],
                    match: str | None = None):
    """Print narrative sequences with optional filtering."""
    regex = re.compile(match, re.IGNORECASE) if match else None

    for session_name, events in sequences_by_session.items():
        if regex:
            # Only show windows around matching events
            matching_indices = set()
            for i, (_, kind, desc) in enumerate(events):
                full = f"{kind} {desc}"
                if regex.search(full):
                    for j in range(max(0, i - 3), min(len(events), i + 4)):
                        matching_indices.add(j)
            if not matching_indices:
                continue
            print(f"\n## {session_name}\n")
            last_i = -2
            for i in sorted(matching_indices):
                if i > last_i + 1:
                    print("  ...")
                lineno, kind, desc = events[i]
                cleaned = clean_text(desc)
                if kind in ("!! ERROR", "USER"):
                    print(f"- **`L{lineno}` {kind}** {cleaned[:120]}")
                else:
                    print(f"- `L{lineno}` {kind} {cleaned[:120]}")
                last_i = i
        else:
            print(f"\n## {session_name} ({len(events)} events)\n")
            for lineno, kind, desc in events:
                cleaned = clean_text(desc)
                if kind in ("!! ERROR", "USER"):
                    print(f"- **`L{lineno}` {kind}** {cleaned[:120]}")
                else:
                    print(f"- `L{lineno}` {kind} {cleaned[:120]}")


def print_compactions(compactions_by_session: dict[str, list[tuple[str, int]]]):
    """Print compaction summaries."""
    for session_name, items in compactions_by_session.items():
        for summary, lineno in items:
            print(f"\n## {session_name} (L{lineno})\n")
            print(summary[:2000])


def main():
    parser = argparse.ArgumentParser(
        description="Extract patterns from pi session files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--sessions-dir",
        help="Sessions directory (auto-discovered from CWD if omitted)",
    )
    parser.add_argument(
        "--last", type=int, default=10,
        help="Number of most recent sessions to analyze (default: 10)",
    )
    parser.add_argument(
        "--match", help="Regex filter applied to extracted items",
    )
    parser.add_argument(
        "--stats", action="store_true",
        help="Show frequency table instead of raw items",
    )
    parser.add_argument(
        "--top", type=int, default=30,
        help="Number of top items in frequency table (default: 30)",
    )

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--commands", action="store_true",
        help="Extract bash commands",
    )
    group.add_argument(
        "--reads", action="store_true",
        help="Extract file read paths",
    )
    group.add_argument(
        "--failures", action="store_true",
        help="Extract tool failures (isError=true or error patterns in output)",
    )
    group.add_argument(
        "--sequences", action="store_true",
        help="Narrative view: tool calls, user messages, and failures in order",
    )
    group.add_argument(
        "--compactions", action="store_true",
        help="Show compaction summaries (session goals, progress, blockers)",
    )
    group.add_argument(
        "--summary", action="store_true",
        help="Overview: tool call counts, session count, date range",
    )

    args = parser.parse_args()

    # Find sessions directory
    sessions_dir = args.sessions_dir
    if not sessions_dir:
        sessions_dir = find_sessions_dir()
        if not sessions_dir:
            print(
                f"No sessions directory found for {os.getcwd()}",
                file=sys.stderr,
            )
            print(
                "Use --sessions-dir to specify explicitly.",
                file=sys.stderr,
            )
            sys.exit(1)

    files = get_session_files(sessions_dir, args.last)
    if not files:
        print("No session files found.", file=sys.stderr)
        sys.exit(1)

    print(
        f"Analyzing {len(files)} sessions from {os.path.basename(sessions_dir)}",
        file=sys.stderr,
    )

    # Summary mode
    if args.summary:
        tool_counts: Counter = Counter()
        total_messages = 0
        total_failures = 0
        for fpath in files:
            for _, obj in iter_lines(fpath):
                if obj.get("type") != "message":
                    continue
                msg = obj["message"]
                total_messages += 1
                if msg.get("role") == "assistant":
                    for block in msg.get("content", []):
                        if isinstance(block, dict) and block.get("type") == "toolCall":
                            tool_counts[block.get("name", "unknown")] += 1
                elif msg.get("role") == "toolResult":
                    if msg.get("isError"):
                        total_failures += 1
        print(f"## Summary\n")
        print(f"- **Sessions:** {len(files)}")
        print(f"- **Messages:** {total_messages}")
        print(f"- **Tool failures** (isError=true): {total_failures}")
        print(f"\n### Tool usage\n")
        for tool, count in tool_counts.most_common():
            print(f"- `{tool}`: {count}×")
        return

    # Compactions mode
    if args.compactions:
        compactions: dict[str, list[tuple[str, int]]] = {}
        for fpath in files:
            label = session_label(fpath)
            items = list(extract_compactions(fpath))
            if items:
                compactions[label] = items
        if compactions:
            print_compactions(compactions)
        else:
            print("No compactions found.", file=sys.stderr)
        return

    # Sequences mode
    if args.sequences:
        seqs: dict[str, list[tuple[int, str, str]]] = {}
        for fpath in files:
            label = session_label(fpath)
            events = list(extract_sequences(fpath))
            if events:
                seqs[label] = events
        if seqs:
            print_sequences(seqs, args.match)
        else:
            print("No events found.", file=sys.stderr)
        return

    # Standard extraction modes
    items_by_session: dict[str, list[tuple[str, int]]] = {}
    for fpath in files:
        label = session_label(fpath)
        if args.commands:
            raw = list(extract_commands(fpath))
        elif args.reads:
            raw = list(extract_reads(fpath))
        elif args.failures:
            raw = list(extract_failures(fpath))
        else:
            raw = []

        filtered = list(match_filter(raw, args.match))
        if filtered:
            items_by_session[label] = filtered

    if not items_by_session:
        print("No matching items found.", file=sys.stderr)
        sys.exit(0)

    if args.stats:
        print_stats(items_by_session, args.top)
    else:
        print_items(items_by_session)


if __name__ == "__main__":
    main()

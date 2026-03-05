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

Assistant messages have a "stopReason" field:
  - "toolUse": agent made a tool call
  - "stop": agent finished its turn
  - "aborted": user interrupted/cancelled the agent's turn

Usage examples:
  # Overview: session count, tool usage
  extract.py --summary

  # Frequency tables
  extract.py --commands --stats          # most common bash commands
  extract.py --reads --stats             # most read files
  extract.py --failures --stats          # tool failures (isError=true) with triggering command
  extract.py --failures --include-heuristic  # also show pattern-matched output (noisy)

  # User corrections: aborted turns + what the user said next
  extract.py --corrections               # all aborts (including thinking-only)
  extract.py --corrections --stats       # most common correction patterns

  # Deep-dive with regex filter
  extract.py --commands --match "git "
  extract.py --failures --match "syntax|paren"

  # Narrative view: see what happened in order
  extract.py --sequences                 # all sessions
  extract.py --sequences --match "FAIL"  # only show around failures

  # Session summaries from compaction
  extract.py --compactions

  # Multi-project analysis
  extract.py --failures --stats --projects ~/co/project-a ~/co/project-b

  # Date filtering (compare before/after a change)
  extract.py --failures --stats --after 2026-03-01
  extract.py --failures --stats --before 2026-03-01

  # Explicit sessions directory and count
  extract.py --sessions-dir ~/.pi/agent/sessions/--my-project--/ --commands --last 20

  # Deep-dive into a specific moment (no truncation)
  extract.py --context 42 --session-file ~/.pi/agent/sessions/<dir>/<file>.jsonl
"""

import argparse
import json
import glob
import os
import re
import sys
from collections import Counter


def find_sessions_dir(project_path: str | None = None) -> str | None:
    """Find the pi sessions directory for a project path (or CWD)."""
    path = project_path or os.getcwd()
    path = os.path.expanduser(path)
    path = os.path.realpath(path)
    mangled = "--" + path.strip("/").replace("/", "-") + "--"
    sessions_base = os.path.expanduser("~/.pi/agent/sessions")
    candidate = os.path.join(sessions_base, mangled)
    if os.path.isdir(candidate):
        return candidate
    return None


def filter_by_date(files: list[str],
                   before: str | None = None,
                   after: str | None = None) -> list[str]:
    """Filter session files by the date embedded in their filename.

    before/after are ISO date strings like '2026-03-01'. The filename
    format is: 2026-03-05T14-45-39-708Z_<uuid>.jsonl
    """
    if not before and not after:
        return files
    filtered = []
    for f in files:
        file_date = os.path.basename(f)[:10]
        if before and file_date >= before:
            continue
        if after and file_date < after:
            continue
        filtered.append(f)
    return filtered


def get_session_files(sessions_dir: str, last: int,
                      before: str | None = None,
                      after: str | None = None) -> list[str]:
    """Get the N most recent session files, optionally filtered by date."""
    files = sorted(
        glob.glob(os.path.join(sessions_dir, "*.jsonl")),
        key=os.path.getmtime,
        reverse=True,
    )
    return filter_by_date(files, before, after)[:last]


def get_multi_project_files(
    project_dirs: list[str], last: int,
    before: str | None = None, after: str | None = None,
) -> tuple[list[str], dict[str, str]]:
    """Get session files across multiple project directories.

    Returns (files, project_map) where project_map maps each filepath
    to the basename of the project directory it came from.
    """
    all_files: list[str] = []
    project_map: dict[str, str] = {}
    for project_dir in project_dirs:
        sessions_dir = find_sessions_dir(project_dir)
        if not sessions_dir:
            print(
                f"Warning: no sessions found for {project_dir}",
                file=sys.stderr,
            )
            continue
        name = os.path.basename(os.path.realpath(project_dir))
        files = glob.glob(os.path.join(sessions_dir, "*.jsonl"))
        for f in files:
            project_map[f] = name
        all_files.extend(files)
    all_files.sort(key=os.path.getmtime, reverse=True)
    result = filter_by_date(all_files, before, after)[:last]
    return result, project_map


def session_label(filepath: str, project_name: str | None = None) -> str:
    """Short unique label like '01-30T17:56_21f5' from filename.

    Input: 2026-01-30T17-56-34-023Z_21f5ff0a-f0f3-4639-...jsonl
    Output: 01-30T17:56_21f5

    With project_name, prepends it: roblox-pi-template/01-30T17:56_21f5
    """
    name = os.path.basename(filepath)
    try:
        month_day = name[5:10]  # "01-30"
        hour = name[11:13]
        minute = name[14:16]
        uuid4 = name.split("_")[1][:4] if "_" in name else "????"
        label = f"{month_day}T{hour}:{minute}_{uuid4}"
    except (IndexError, ValueError):
        label = name[:20]

    if project_name:
        label = f"{project_name}/{label}"

    return label


def session_header(label: str, filepath: str, count: int | None = None) -> str:
    """Format a session header with label, filepath, and optional item count."""
    parts = [label]
    if count is not None:
        parts.append(f"({count} items)")
    parts.append(f"\n  {filepath}")
    return " ".join(parts)


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


def extract_failures(filepath: str, include_heuristic: bool = False):
    """Yield (description, lineno) for tool results that failed.

    Always includes isError=true results (ground truth from tool exit code).
    With include_heuristic=True, also includes output text matching error
    patterns — useful for catching HTTP errors etc. but noisy.
    """
    # Track recent tool calls so we can pair errors with their commands
    pending_calls: list[tuple[str, str]] = []  # [(tool_name, summary), ...]

    for lineno, obj in iter_lines(filepath):
        if obj.get("type") != "message":
            continue
        msg = obj["message"]

        if msg.get("role") == "assistant":
            pending_calls = []
            for block in msg.get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") != "toolCall":
                    continue
                name = block.get("name", "")
                args = block.get("arguments", {})
                if name == "bash":
                    summary = args.get("command", "")[:200]
                elif name in ("edit", "write", "read"):
                    summary = args.get("path", "").split("/")[-1]
                else:
                    summary = str(args)[:200]
                pending_calls.append((name, summary))
            continue

        if msg.get("role") != "toolResult":
            continue

        is_error = msg.get("isError", False)
        tool = msg.get("toolName", "?")
        text = ""
        for block in msg.get("content", []):
            if isinstance(block, dict):
                text = block.get("text", "")
        snippet = clean_text(text[:1000])

        # Pair with triggering command (consume first pending call)
        cmd_context = ""
        if pending_calls:
            call_name, call_summary = pending_calls.pop(0)
            if call_summary:
                cmd_context = f": {call_summary}"

        if is_error:
            yield f"[ERROR] [{tool}{cmd_context}] {snippet}", lineno
        elif (include_heuristic
              and tool != "read"
              and FAIL_PATTERN.search(text[:500])):
            yield f"[output] [{tool}{cmd_context}] {snippet}", lineno


def _summarize_agent_content(msg: dict) -> str:
    """Summarize what the agent was doing when aborted."""
    actions = []
    for block in msg.get("content", []):
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "toolCall":
            name = block.get("name", "")
            args = block.get("arguments", {})
            if name == "bash":
                actions.append(f"bash: {args.get('command', '')[:200]}")
            elif name in ("edit", "write", "read"):
                path = args.get("path", "").split("/")[-1]
                actions.append(f"{name}: {path}")
            else:
                actions.append(name)
        elif block_type == "text":
            t = block.get("text", "").strip()
            if t:
                actions.append(f"text: {t[:300]}")
        elif block_type == "thinking":
            t = block.get("thinking", "").strip()
            if t:
                actions.append(f"thinking: {t[:300]}")
    if actions:
        return " | ".join(actions[:4])
    return "[no content yet]"


def extract_corrections(filepath: str):
    """Yield (description, lineno) for user corrections after aborted agent turns.

    Detects stopReason=="aborted" on assistant messages, then pairs with
    the next user message — which is the correction or redirect.
    """
    lines = list(iter_lines(filepath))
    for i, (lineno, obj) in enumerate(lines):
        if obj.get("type") != "message":
            continue
        msg = obj["message"]
        if msg.get("role") != "assistant" or msg.get("stopReason") != "aborted":
            continue

        agent_summary = _summarize_agent_content(msg)

        # Find next user message (the correction/redirect)
        next_user = ""
        for j in range(i + 1, min(i + 5, len(lines))):
            _, next_obj = lines[j]
            if (next_obj.get("type") == "message"
                    and next_obj.get("message", {}).get("role") == "user"):
                for block in next_obj["message"].get("content", []):
                    if isinstance(block, dict) and block.get("type") == "text":
                        next_user = block.get("text", "").strip()
                break

        if next_user:
            description = (
                f"AGENT (aborted): {agent_summary}\n"
                f"  USER: {next_user[:500].replace(chr(10), ' ')}"
            )
            yield description, lineno


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
            summary = obj.get("summary", "")[:500].replace("\n", " ")
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
                        yield lineno, "USER", t[:500].replace("\n", " ")

        elif role == "assistant":
            for block in msg.get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "toolCall":
                    name = block.get("name", "")
                    args = block.get("arguments", {})
                    if name == "bash":
                        yield lineno, "BASH", args.get("command", "")[:500]
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
                        yield lineno, name.upper()[:8], str(args)[:300]

        elif role == "toolResult":
            is_error = msg.get("isError", False)
            if is_error:
                tool = msg.get("toolName", "?")
                text = ""
                for block in msg.get("content", []):
                    if isinstance(block, dict):
                        text = block.get("text", "")
                snippet = clean_text(text[:1000])
                yield lineno, "!! ERROR", f"[{tool}] {snippet}"


def extract_context(filepath: str, target_line: int, window: int = 5):
    """Print full untruncated context around a specific line in a session file.

    Shows `window` lines before and after `target_line`, with full content
    for each message — tool calls with complete arguments, tool results with
    complete output, user messages in full, and assistant text/thinking in full.
    """
    lines = list(iter_lines(filepath))
    line_index = {lineno: obj for lineno, obj in lines}

    # Find the target and its window
    all_linenos = [lineno for lineno, _ in lines]
    try:
        idx = all_linenos.index(target_line)
    except ValueError:
        # Find nearest line
        nearest = min(all_linenos, key=lambda n: abs(n - target_line))
        print(f"Line {target_line} not found; nearest is L{nearest}",
              file=sys.stderr)
        idx = all_linenos.index(nearest)

    start = max(0, idx - window)
    end = min(len(all_linenos), idx + window + 1)

    print(f"## Context around L{target_line} in {filepath}\n")
    print(f"Showing L{all_linenos[start]}–L{all_linenos[end - 1]} "
          f"({end - start} entries)\n")

    for i in range(start, end):
        lineno = all_linenos[i]
        obj = line_index[lineno]
        marker = " **>>>**" if lineno == target_line else ""

        obj_type = obj.get("type", "?")

        if obj_type == "compaction":
            summary = obj.get("summary", "")
            print(f"### L{lineno} COMPACTION{marker}\n")
            print(summary)
            print()
            continue

        if obj_type != "message":
            print(f"### L{lineno} {obj_type.upper()}{marker}\n")
            # Show key fields for non-message types
            for key in ("model", "thinkingLevel", "sessionId", "cwd"):
                if key in obj:
                    print(f"- {key}: {obj[key]}")
            print()
            continue

        msg = obj["message"]
        role = msg.get("role", "?")
        stop_reason = msg.get("stopReason", "")
        stop_suffix = f" (stopReason={stop_reason})" if stop_reason else ""

        if role == "user":
            print(f"### L{lineno} USER{marker}\n")
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("type") == "text":
                    print(block.get("text", ""))
            print()

        elif role == "assistant":
            print(f"### L{lineno} ASSISTANT{stop_suffix}{marker}\n")
            for block in msg.get("content", []):
                if not isinstance(block, dict):
                    continue
                bt = block.get("type")
                if bt == "thinking":
                    print(f"**Thinking:**")
                    print(block.get("thinking", ""))
                    print()
                elif bt == "text":
                    text = block.get("text", "").strip()
                    if text:
                        print(text)
                        print()
                elif bt == "toolCall":
                    name = block.get("name", "")
                    args = block.get("arguments", {})
                    print(f"**Tool call: {name}**")
                    if name == "bash":
                        print(f"```bash\n{args.get('command', '')}\n```")
                    elif name == "edit":
                        print(f"- path: `{args.get('path', '')}`")
                        print(f"- oldText:\n```\n{args.get('oldText', '')}\n```")
                        print(f"- newText:\n```\n{args.get('newText', '')}\n```")
                    elif name == "write":
                        print(f"- path: `{args.get('path', '')}`")
                        content = args.get("content", "")
                        print(f"- content ({len(content)} chars):\n```\n{content[:3000]}\n```")
                    elif name == "read":
                        print(f"- path: `{args.get('path', '')}`")
                        for k in ("offset", "limit"):
                            if k in args:
                                print(f"- {k}: {args[k]}")
                    else:
                        print(f"```json\n{json.dumps(args, indent=2)}\n```")
                    print()

        elif role == "toolResult":
            is_error = msg.get("isError", False)
            tool = msg.get("toolName", "?")
            error_tag = " ERROR" if is_error else ""
            print(f"### L{lineno} TOOL RESULT [{tool}]{error_tag}{marker}\n")
            for block in msg.get("content", []):
                if isinstance(block, dict):
                    text = block.get("text", "")
                    if text:
                        print(text)
            print()

        else:
            print(f"### L{lineno} {role.upper()}{marker}\n")
            print(json.dumps(msg, indent=2)[:2000])
            print()


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
                top: int = 30,
                filepaths: dict[str, str] | None = None):
    """Print frequency table as markdown cards."""
    total_counter: Counter = Counter()
    session_counter: Counter = Counter()
    example_lines: dict[str, list[str]] = {}

    for session_name, items in items_by_session.items():
        seen: set[str] = set()
        for value, lineno in items:
            cleaned = clean_text(value)
            normalized = re.sub(r"\s+", " ", cleaned)
            key = normalized[:300]
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

    if filepaths:
        print("**Session files:**")
        for name in items_by_session:
            path = filepaths.get(name, "")
            if path:
                print(f"- {name}: `{path}`")
        print()

    for rank, (key, count) in enumerate(
        total_counter.most_common(top), 1
    ):
        sessions = session_counter[key]
        refs = example_lines[key][:3]
        print(f"**#{rank}** — **{count}×** across {sessions} session(s)")
        print(f"`{key}`")
        print(f"e.g. {', '.join(refs)}")
        print()


def print_items(items_by_session: dict[str, list[tuple[str, int]]],
                filepaths: dict[str, str] | None = None):
    """Print items grouped by session with line references."""
    for session_name, items in items_by_session.items():
        if items:
            filepath = (filepaths or {}).get(session_name, "")
            print(f"\n## {session_header(session_name, filepath, len(items))}\n")
            for value, lineno in items:
                cleaned = clean_text(value)
                print(f"- `L{lineno}` {cleaned[:500]}")


def print_sequences(sequences_by_session: dict[str, list[tuple[int, str, str]]],
                    match: str | None = None,
                    filepaths: dict[str, str] | None = None):
    """Print narrative sequences with optional filtering."""
    regex = re.compile(match, re.IGNORECASE) if match else None

    for session_name, events in sequences_by_session.items():
        filepath = (filepaths or {}).get(session_name, "")
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
            print(f"\n## {session_header(session_name, filepath)}\n")
            last_i = -2
            for i in sorted(matching_indices):
                if i > last_i + 1:
                    print("  ...")
                lineno, kind, desc = events[i]
                cleaned = clean_text(desc)
                if kind in ("!! ERROR", "USER"):
                    print(f"- **`L{lineno}` {kind}** {cleaned[:500]}")
                else:
                    print(f"- `L{lineno}` {kind} {cleaned[:500]}")
                last_i = i
        else:
            print(f"\n## {session_header(session_name, filepath, len(events))}\n")
            for lineno, kind, desc in events:
                cleaned = clean_text(desc)
                if kind in ("!! ERROR", "USER"):
                    print(f"- **`L{lineno}` {kind}** {cleaned[:500]}")
                else:
                    print(f"- `L{lineno}` {kind} {cleaned[:500]}")


def print_compactions(compactions_by_session: dict[str, list[tuple[str, int]]],
                      filepaths: dict[str, str] | None = None):
    """Print compaction summaries."""
    for session_name, items in compactions_by_session.items():
        filepath = (filepaths or {}).get(session_name, "")
        for summary, lineno in items:
            print(f"\n## {session_header(session_name, filepath)} (L{lineno})\n")
            print(summary)


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
        "--projects", nargs="+", metavar="DIR",
        help="Analyze sessions from multiple project directories",
    )
    parser.add_argument(
        "--last", type=int, default=10,
        help="Number of most recent sessions to analyze (default: 10)",
    )
    parser.add_argument(
        "--before", metavar="DATE",
        help="Only sessions before this date (ISO format: 2026-03-01)",
    )
    parser.add_argument(
        "--after", metavar="DATE",
        help="Only sessions on or after this date (ISO format: 2026-03-01)",
    )
    parser.add_argument(
        "--match", help="Regex filter applied to extracted items",
    )
    parser.add_argument(
        "--include-heuristic", action="store_true",
        help="With --failures: also show heuristic matches from output text (noisy)",
    )
    parser.add_argument(
        "--stats", action="store_true",
        help="Show frequency table instead of raw items",
    )
    parser.add_argument(
        "--top", type=int, default=30,
        help="Number of top items in frequency table (default: 30)",
    )

    # Context mode (standalone — does not use the mutually exclusive group)
    parser.add_argument(
        "--context", type=int, metavar="LINE",
        help="Show full untruncated context around LINE in a session file",
    )
    parser.add_argument(
        "--session-file",
        help="Session file path (required with --context)",
    )
    parser.add_argument(
        "--window", type=int, default=5,
        help="Number of entries before/after --context line (default: 5)",
    )

    group = parser.add_mutually_exclusive_group(required=False)
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
        "--corrections", action="store_true",
        help="Extract user corrections: aborted agent turns + next user message",
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

    # Context mode: deep-dive into a specific line (standalone)
    if args.context is not None:
        if not args.session_file:
            print("--context requires --session-file", file=sys.stderr)
            sys.exit(1)
        session_file = os.path.expanduser(args.session_file)
        if not os.path.isfile(session_file):
            print(f"File not found: {session_file}", file=sys.stderr)
            sys.exit(1)
        extract_context(session_file, args.context, args.window)
        return

    # Require a mode if not --context
    if not any([args.commands, args.reads, args.failures, args.corrections,
                args.sequences, args.compactions, args.summary]):
        parser.error("one of --commands, --reads, --failures, --corrections, "
                      "--sequences, --compactions, --summary, or --context is required")

    # Resolve session files: --projects, --sessions-dir, or auto-discover
    project_map: dict[str, str] = {}  # filepath → project name

    if args.projects:
        files, project_map = get_multi_project_files(
            args.projects, args.last,
            before=args.before, after=args.after,
        )
        if not files:
            print("No session files found for given projects.", file=sys.stderr)
            sys.exit(1)
        project_names = ", ".join(
            os.path.basename(p) for p in args.projects
        )
        print(
            f"Analyzing {len(files)} sessions across: {project_names}",
            file=sys.stderr,
        )
    else:
        sessions_dir = args.sessions_dir
        if not sessions_dir:
            sessions_dir = find_sessions_dir()
            if not sessions_dir:
                print(
                    f"No sessions directory found for {os.getcwd()}",
                    file=sys.stderr,
                )
                print(
                    "Use --sessions-dir or --projects to specify explicitly.",
                    file=sys.stderr,
                )
                sys.exit(1)

        files = get_session_files(
            sessions_dir, args.last,
            before=args.before, after=args.after,
        )
        if not files:
            print("No session files found.", file=sys.stderr)
            sys.exit(1)

        print(
            f"Analyzing {len(files)} sessions from "
            f"{os.path.basename(sessions_dir)}",
            file=sys.stderr,
        )

    # Build label → filepath map for all resolved files
    filepath_map: dict[str, str] = {}  # label → filepath
    for fpath in files:
        label = session_label(fpath, project_map.get(fpath))
        filepath_map[label] = fpath

    # Summary mode
    if args.summary:
        tool_counts: Counter = Counter()
        total_messages = 0
        total_failures = 0
        total_aborts = 0
        for fpath in files:
            for _, obj in iter_lines(fpath):
                if obj.get("type") != "message":
                    continue
                msg = obj["message"]
                total_messages += 1
                if msg.get("role") == "assistant":
                    if msg.get("stopReason") == "aborted":
                        total_aborts += 1
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
        print(f"- **User aborts** (stopReason=aborted): {total_aborts}")
        print(f"\n### Tool usage\n")
        for tool, count in tool_counts.most_common():
            print(f"- `{tool}`: {count}×")
        return

    # Compactions mode
    if args.compactions:
        compactions: dict[str, list[tuple[str, int]]] = {}
        for fpath in files:
            label = session_label(fpath, project_map.get(fpath))
            items = list(extract_compactions(fpath))
            if items:
                compactions[label] = items
        if compactions:
            print_compactions(compactions, filepath_map)
        else:
            print("No compactions found.", file=sys.stderr)
        return

    # Sequences mode
    if args.sequences:
        seqs: dict[str, list[tuple[int, str, str]]] = {}
        for fpath in files:
            label = session_label(fpath, project_map.get(fpath))
            events = list(extract_sequences(fpath))
            if events:
                seqs[label] = events
        if seqs:
            print_sequences(seqs, args.match, filepath_map)
        else:
            print("No events found.", file=sys.stderr)
        return

    # Standard extraction modes
    items_by_session: dict[str, list[tuple[str, int]]] = {}
    for fpath in files:
        label = session_label(fpath, project_map.get(fpath))
        if args.commands:
            raw = list(extract_commands(fpath))
        elif args.reads:
            raw = list(extract_reads(fpath))
        elif args.failures:
            raw = list(extract_failures(fpath, args.include_heuristic))
        elif args.corrections:
            raw = list(extract_corrections(fpath))
        else:
            raw = []

        filtered = list(match_filter(raw, args.match))
        if filtered:
            items_by_session[label] = filtered

    if not items_by_session:
        print("No matching items found.", file=sys.stderr)
        sys.exit(0)

    if args.stats:
        print_stats(items_by_session, args.top, filepath_map)
    else:
        print_items(items_by_session, filepath_map)


if __name__ == "__main__":
    main()

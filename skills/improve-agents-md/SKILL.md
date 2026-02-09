---
name: improve-agents-md
description: Analyze past session files to find recurring AI agent issues and fix them via AGENTS.md or code changes. Use when asked to improve agent workflow, find recurring problems, or optimize AGENTS.md.
---

# Improve AGENTS.md

Analyze past pi coding sessions to find recurring agent issues, then fix
them by updating AGENTS.md (or code/infra).

> **Note:** This skill is pi-specific. It reads pi session files from
> `~/.pi/agent/sessions/` and targets `AGENTS.md` for improvements.

## How It Works

Pi stores every session as a JSONL file in `~/.pi/agent/sessions/<mangled-cwd>/`.
Each session captures tool calls (bash, read, edit, write), tool results
(with success/failure), user messages, assistant reasoning, and compaction
summaries. By analyzing patterns across sessions, we identify where the
agent repeatedly struggles and fix the root causes.

## Extraction Script

```bash
python3 {baseDir}/extract.py [options]
```

Auto-discovers the sessions directory from `$PWD`. Use `--sessions-dir` to override.

### Modes

| Mode | What it extracts |
|------|------------------|
| `--summary` | Overview: session count, tool usage, failure count |
| `--commands --stats` | Most common bash commands (frequency table) |
| `--reads --stats` | Most read files |
| `--failures --stats` | Tool failures: `isError=true` or error patterns in output |
| `--sequences` | Narrative view: tool calls, user messages, failures in order |
| `--sequences --match ERROR` | Zoom into error sequences with surrounding context |
| `--compactions` | Session summaries: goals, progress, blockers, decisions |

### Common Options

| Flag | Description |
|------|-------------|
| `--match REGEX` | Filter items by regex |
| `--stats` | Frequency table instead of raw output |
| `--last N` | Number of recent sessions (default: 10) |
| `--top N` | Items in frequency table (default: 30) |
| `--sessions-dir PATH` | Override auto-discovered sessions dir |

### Output Format

All output includes JSONL line references (`L:NNN` or `session:LNNN`).
To drill into a specific event, grep the session file:

```bash
sed -n '42p' ~/.pi/agent/sessions/<dir>/<session>.jsonl | python3 -m json.tool
```

## Workflow

Follow these steps in order. Present findings to the user after each step.

### Step 1: Overview and Context

```bash
python3 {baseDir}/extract.py --summary
```

Read the project's `AGENTS.md` if it exists. Understand what guidance the
agent already has.

### Step 2: Find Recurring Patterns

Run all three frequency analyses:

```bash
python3 {baseDir}/extract.py --commands --stats
python3 {baseDir}/extract.py --failures --stats
python3 {baseDir}/extract.py --reads --stats
```

Look for:
- **High frequency, many sessions**: agent doing the same thing over and over
- **Recurring failures**: same errors across sessions
- **Repeated file reads**: agent can't find what it needs
- **Command variations**: same intent, many spellings (e.g. `make test | tail -5`,
  `make test | tail -10`, `make test | tail -20` — noisy output problem)

### Step 3: Understand the Stories

For the top patterns, use sequences to see *what happened*:

```bash
# See error narratives
python3 {baseDir}/extract.py --sequences --match "ERROR"

# Deep-dive into specific patterns
python3 {baseDir}/extract.py --commands --match "git add"
python3 {baseDir}/extract.py --failures --match "syntax|paren|not found"
```

The sequence view shows:
- `USER` messages — what the user asked for or complained about
- `BASH/EDIT/READ/WRITE` — what the agent did
- `!! ERROR` — where things went wrong (ground truth: non-zero exit / tool error)
- Context before and after failures reveals the root cause

Also check compaction summaries for session-level context:

```bash
python3 {baseDir}/extract.py --compactions
```

### Step 3b: Go Off-Script — Investigate the Raw JSONL

The extraction script is for the initial sweep. Once you have a suspicious
pattern and a line number, **go straight to the JSONL** with jq, grep, or
python one-liners. The script can't anticipate every question — you can.

Session files live in `~/.pi/agent/sessions/<mangled-cwd>/`. Each line is
a self-contained JSON object. Key fields:

```
type: "message" | "compaction" | "session" | ...
message.role: "user" | "assistant" | "toolResult"
message.content[].type: "text" | "toolCall"
message.content[].name: "bash" | "read" | "edit" | "write" | ...
message.isError: true/false  (on toolResult messages)
```

Example investigations:

```bash
# Get full context around a suspicious line
S=~/.pi/agent/sessions/<dir>/<file>.jsonl
sed -n '40,50p' "$S" | jq -r '.message.content[]?.text // empty' | head -40

# All user messages (complaints, corrections, instructions)
jq -r 'select(.type=="message") | select(.message.role=="user")
  | .message.content[]? | select(.type=="text") | .text' "$S"

# Full error output for a specific toolResult (not truncated)
sed -n '42p' "$S" | jq -r '.message.content[].text'

# All tool calls in order with their names (quick narrative)
jq -r 'select(.type=="message") | select(.message.role=="assistant")
  | .message.content[]? | select(.type=="toolCall")
  | "\(.name): \(.arguments | tostring | .[0:120])"' "$S"

# Count consecutive edits to the same file (struggle detector)
jq -r 'select(.type=="message") | select(.message.role=="assistant")
  | .message.content[]? | select(.type=="toolCall")
  | select(.name=="edit") | .arguments.path' "$S" \
  | uniq -c | sort -rn | head

# All toolResult errors with full output
jq -r 'select(.type=="message") | select(.message.role=="toolResult")
  | select(.message.isError==true)
  | "[\(.message.toolName)] \(.message.content[0].text[0:300])"' "$S"

# What did the assistant say right after an error? (reaction pattern)
# Use line numbers: if error is at L42, check L43
sed -n '43p' "$S" | jq -r '.message.content[]?
  | select(.type=="text") | .text[0:300]'

# Find retry/struggle loops: same command repeated within 10 lines
jq -r 'select(.type=="message") | select(.message.role=="assistant")
  | .message.content[]? | select(.type=="toolCall")
  | select(.name=="bash") | .arguments.command' "$S" \
  | uniq -c | sort -rn | head
```

Trust your judgment. If the extract.py output raises a question, answer
it directly from the data. The JSONL has everything — full tool output,
full user messages, full assistant reasoning. Don't stay at the summary
level when the details matter.

### Step 4: Rank Issues by Impact

For each issue found, assess:
- **Frequency**: how many times it occurs
- **Sessions affected**: how many separate sessions
- **Cost per occurrence**: how many commands wasted recovering

Rank by `frequency × sessions`. Focus on the top issues.

### Step 5: Present and Resolve One by One

For each issue, present to the user:
1. **What**: the observable pattern with quantitative data
2. **Why**: root cause analysis
3. **Options**: 2-3 resolution approaches

Resolution types:
- **AGENTS.md**: Concise instructions preventing the agent from repeating the mistake
- **Code/infra**: Makefile targets, helper scripts, gitignore rules, pre-commit hooks
- **Both**: Document AND provide tooling

Wait for user to pick before implementing. Then implement and verify
the change works by running a quick non-interactive pi session:

```bash
# Test that the updated AGENTS.md is loaded and understood
pi -p "Read AGENTS.md and confirm you see the new guidance about <topic>"

# Or test the specific behavior the new guidance should produce
pi -p "Show me how you would <thing the agent kept getting wrong>"
```

Then commit and move to the next issue.

## Writing Good AGENTS.md Entries

- **Concise**: 3-5 lines per topic. The agent reads this every session.
- **Actionable**: Commands to run, not explanations of why.
- **Specific**: Exact command syntax, not "use the right flags."
- **No hardcoded paths**: Use `$PWD`, environment variables, or discovery snippets.
- **Grouped**: Related guidance together (testing, git, reference code, etc.)

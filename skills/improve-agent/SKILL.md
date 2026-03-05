---
name: improve-agent
description: Analyze past session files to find recurring AI agent issues and fix them via AGENTS.md updates, new skills, or code/infra changes. Use when asked to improve agent workflow, find recurring problems, optimize AGENTS.md, create skills from session patterns, or understand what went wrong across sessions.
---

# Improve Agent

Analyze past pi coding sessions to find recurring agent issues, then fix
them by updating AGENTS.md, creating new skills, or improving code/infra.

> **Note:** This skill is pi-specific. It reads pi session files from
> `~/.pi/agent/sessions/` and produces AGENTS.md entries, new skills,
> or infrastructure fixes.

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
| `--summary` | Overview: session count, tool usage, failure count, abort count |
| `--commands --stats` | Most common bash commands (frequency table) |
| `--reads --stats` | Most read files |
| `--failures --stats` | Tool failures (`isError=true`) with triggering command context |
| `--corrections` | User corrections: aborted agent turns paired with next user message |
| `--sequences` | Narrative view: tool calls, user messages, failures in order |
| `--sequences --match ERROR` | Zoom into error sequences with surrounding context |
| `--compactions` | Session summaries: goals, progress, blockers, decisions |
| `--context LINE` | Full untruncated context around a specific line in a session file |

### Common Options

| Flag | Description |
|------|-------------|
| `--match REGEX` | Filter items by regex |
| `--stats` | Frequency table instead of raw output |
| `--last N` | Number of recent sessions (default: 10) |
| `--top N` | Items in frequency table (default: 30) |
| `--before DATE` | Only sessions before this date (ISO: 2026-03-01) |
| `--after DATE` | Only sessions on or after this date (ISO: 2026-03-01) |
| `--include-heuristic` | With `--failures`: also show pattern-matched output (noisy) |
| `--sessions-dir PATH` | Override auto-discovered sessions dir |
| `--projects DIR [DIR ...]` | Analyze sessions from multiple project directories |
| `--session-file PATH` | Session file path (required with `--context`) |
| `--window N` | Entries before/after `--context` line (default: 5) |

### Output Format

All output includes JSONL line references (`L:NNN` or `session:LNNN`)
and the **full filepath** to the session file (as a header per session,
or as a legend in stats mode). This lets you jump from any finding
directly to the raw data.

To drill into a specific event with the built-in context viewer:

```bash
python3 {baseDir}/extract.py --context 42 --session-file /path/to/session.jsonl
```

Or manually with jq/sed:

```bash
sed -n '42p' /path/to/session.jsonl | python3 -m json.tool
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

Run the frequency analyses and check user corrections:

```bash
python3 {baseDir}/extract.py --commands --stats
python3 {baseDir}/extract.py --failures --stats
python3 {baseDir}/extract.py --reads --stats
python3 {baseDir}/extract.py --corrections
```

Look for:
- **High frequency, many sessions**: agent doing the same thing over and over
- **Recurring failures**: same errors across sessions
- **Repeated file reads**: agent can't find what it needs
- **Command variations**: same intent, many spellings (e.g. `make test | tail -5`,
  `make test | tail -10`, `make test | tail -20` — noisy output problem)
- **User corrections**: what the user aborted and redirected — these reveal
  cases where the agent technically succeeded but did the wrong thing

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

### Step 3a: Zoom Into Specific Moments

When a sweep surfaces something interesting at a specific line, use
`--context` to see the full untruncated picture — complete tool output,
full user messages, full assistant reasoning and thinking:

```bash
# The filepath is shown in every session header — copy it directly
python3 {baseDir}/extract.py --context 42 --session-file /path/to/session.jsonl

# Wider window for complex sequences
python3 {baseDir}/extract.py --context 42 --session-file /path/to/session.jsonl --window 10
```

This is the primary drill-down tool. Use it whenever a line number
catches your attention in the sweep output.

### Step 3b: Go Off-Script — Investigate the Raw JSONL

`--context` covers most drill-down needs, but sometimes you need to ask
questions it can't answer — correlating events far apart in a session,
counting patterns across the whole file, or extracting specific fields.
For those, go straight to the JSONL with jq, grep, or python one-liners.

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

#### Choosing the Right Resolution

Ask two questions:

**Is the tool/command/infrastructure itself broken or misleading?**
Fix it directly — Makefile target, helper script, git hook, config file,
whatever it takes. The agent shouldn't need guidance to work around
broken tooling.

**Is it knowledge the agent needs?**
Two options, depending on scope:

- **AGENTS.md entry** — for concise, project-specific guidance the agent
  needs every session. See "Writing Good AGENTS.md Entries" below.
- **New skill** — for rich, reusable workflows that span sessions or
  projects. See "Step 5b: Create a Skill" below.

Often the answer is both: fix the broken command AND document the correct
usage. Present options to the user, wait for them to pick, then implement.

Verify the change works:

```bash
# Test that the updated AGENTS.md is loaded and understood
pi -p "Read AGENTS.md and confirm you see the new guidance about <topic>"

# Or test the specific behavior the new guidance should produce
pi -p "Show me how you would <thing the agent kept getting wrong>"
```

Then commit and move to the next issue.

### Step 5b: Create a Skill

When analysis reveals a **recurring multi-step workflow** — the agent
writing the same helper scripts across sessions, following the same
complex sequence of commands, or needing the same domain knowledge
repeatedly — that's a skill, not an AGENTS.md entry.

**Recognizing skill opportunities:**
- The agent writes similar ad-hoc scripts in 3+ sessions
- A workflow requires 5+ steps that the agent reinvents each time
- Domain-specific knowledge (API patterns, tool quirks) keeps being
  rediscovered
- The pattern appears across multiple projects (use `--projects` to check)

**Creating the skill:**

1. **Extract intent from session data.** The sessions already show what
   the skill needs to do. Look at the successful command sequences,
   the scripts the agent wrote, and the user corrections that refined
   the approach.

2. **Scaffold the SKILL.md.** Use proper frontmatter:
   ```yaml
   ---
   name: my-skill
   description: What it does and when to trigger. Be specific about
     contexts — include phrases users would say. Err on the side of
     triggering too often rather than too rarely.
   ---
   ```

3. **Write the workflow.** Translate the successful patterns from session
   data into clear steps. Explain *why* each step matters — the agent is
   smart and responds better to reasoning than rigid instructions.

4. **Bundle repeated scripts.** If the agent kept writing the same helper
   script across sessions, write it once and put it in the skill directory.
   Reference it from SKILL.md with `{baseDir}/scripts/helper.py`.

5. **Test it.** Run a quick pi session to verify the skill triggers and
   the workflow produces good results:
   ```bash
   pi -p "<prompt that should trigger the skill>"
   ```

6. **Keep it lean.** SKILL.md under 500 lines. If it grows beyond that,
   split into a main SKILL.md and `references/` directory with detailed
   docs that get loaded on demand.

### Step 6: Verify Changes Worked

After implementing fixes, verify they had the intended effect in
subsequent sessions. Use `--before`/`--after` to compare windows:

```bash
# Check the pattern before the fix
python3 {baseDir}/extract.py --failures --match "the-pattern" --before 2026-03-01

# Check after the fix
python3 {baseDir}/extract.py --failures --match "the-pattern" --after 2026-03-01
```

If the pattern still appears at similar frequency, the fix didn't work.
Investigate why — the root cause may be different from what you assumed.

This step is optional during the initial analysis but valuable as a
follow-up in a later session.

## Multi-Project Analysis

When the user suspects patterns span multiple projects, or wants to
identify cross-cutting skill opportunities:

```bash
# Analyze failures across two projects
python3 {baseDir}/extract.py --failures --stats \
  --projects ~/co/project-a ~/co/project-b

# Check corrections across projects
python3 {baseDir}/extract.py --corrections \
  --projects ~/co/project-a ~/co/project-b --last 5
```

Each project directory gets resolved to its pi sessions directory
automatically. Output labels include the project name for context.

Cross-project patterns are strong signals for global skills (placed
in `~/.agents/skills/`) or global AGENTS.md entries.

## Writing Good AGENTS.md Entries

- **Concise**: 3-5 lines per topic. The agent reads this every session.
- **Actionable**: Commands to run, not explanations of why.
- **Specific**: Exact command syntax, not "use the right flags."
- **No hardcoded paths**: Use `$PWD`, environment variables, or discovery snippets.
- **Grouped**: Related guidance together (testing, git, reference code, etc.)

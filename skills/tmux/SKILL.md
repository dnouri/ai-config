---
name: tmux
description: Use tmux instead of bash tool to run commands that take more than ~30 seconds, like bulk operations, db migrations, dev servers.
---

# tmux for Long-Running Processes

Use tmux for any process that needs to run independently (dev servers, background tasks, long-running scripts). Do **not** use `nohup`, `&`, or other backgrounding techniques with the bash tool.

## Start a Process

```bash
tmux new-session -d -s <name> '<command> > /tmp/pi-tmux-<name>.log 2>&1'
```

**Naming:** Use descriptive names like `dev-server`, `build-kernel`, `test-run`.

**Examples:**
```bash
# Simple command
tmux new-session -d -s dev-server 'npm run dev > /tmp/pi-tmux-dev-server.log 2>&1'

# Compound commands - use braces to capture all output
tmux new-session -d -s build '{ npm install && npm run build; } > /tmp/pi-tmux-build.log 2>&1'
```

## User Visibility (Required)

Immediately after starting a tmux session, always print copy/paste commands so the user can monitor it:

```bash
# Live monitoring (interactive)
tmux attach -t <name>
# detach with: Ctrl+b d

# One-shot capture (good for quick checks)
tmux capture-pane -p -J -t <name> -S -200

# Stream redirected logs (if configured)
tail -f /tmp/pi-tmux-<name>.log
```

Do not assume the user remembers how to inspect the session. Always provide these commands near the action.

## List Sessions

```bash
tmux ls
```

## Read Output

**For long-running processes**, use log files (these persist even after the process exits):
```bash
# Read with the read tool
/tmp/pi-tmux-<name>.log

# Or tail for recent output
tail -100 /tmp/pi-tmux-<name>.log
```

**For interactive tools** (REPLs, prompts), use joined output plus explicit history depth:
```bash
# Preferred default: clean output from the last 200 lines
tmux capture-pane -p -J -t <name> -S -200

# Increase history depth when debugging harder failures
tmux capture-pane -p -J -t <name> -S -1000
```

Use `-J` to reduce wrapped-line artifacts and `-S -N` to make capture scope explicit/repeatable.
Allow ~0.5 seconds after starting a session before reading output.

## Stop a Session

```bash
tmux kill-session -t <name>
```

## Send Input (Safe Patterns)

For interactive sessions, prefer literal sends so text is passed exactly as intended:

```bash
# Send literal text as-is
tmux send-keys -t <name> -l -- "input text"
# press Enter separately
tmux send-keys -t <name> Enter
```

When text includes `$`, quotes, or shell metacharacters, use shell quoting so your local shell does not rewrite the payload:

```bash
tmux send-keys -t <name> -l -- 'python3 -c "print(\"$HOME should stay literal\")"'
tmux send-keys -t <name> Enter

# Alternative for explicit escapes/newlines
tmux send-keys -t <name> -l -- $'line1\nline2'
```

For control/navigation keys, send key names (not escape sequences):

```bash
tmux send-keys -t <name> C-c
tmux send-keys -t <name> C-d
tmux send-keys -t <name> Escape
tmux send-keys -t <name> Up
tmux send-keys -t <name> Down
```

**Rule of thumb:** use `-l` for literal text, key names for control keys, and `Enter` as a separate argument (not `"text\n"`).

## Wait for Prompt / Synchronize

Interactive CLIs are race-prone. Before sending follow-up input, wait for a prompt or completion marker.

```bash
# Wait for a Python prompt (regex)
./scripts/wait-for-text.sh -t <name>:0.0 -p '^>>> ' -T 15 -l 4000

# Wait for an exact completion message
./scripts/wait-for-text.sh -t <name>:0.0 -p 'Server started' -F -T 30
```

Use this helper whenever command ordering matters (REPLs, debuggers, installers, login flows).
On timeout, the script prints recent pane output to stderr to help debug what went wrong.

## Rules

1. **Always redirect output** to `/tmp/pi-tmux-<name>.log` so you can read it later
2. **Use descriptive session names** - they're easier to manage than PIDs
3. **Check `tmux ls`** before creating sessions to avoid name conflicts
4. **Always print user monitor commands** right after starting a session (`attach`, `capture-pane`, and optionally `tail -f`)
5. **Prefer safe input sending**: literal text with `send-keys -l --`, then send `Enter`/control keys separately
6. **Prefer explicit pane capture** for interactive output: `capture-pane -p -J -S -N` (start with `-S -200`)
7. **Synchronize interactive flows** with `./scripts/wait-for-text.sh` before sending follow-up commands
8. **Always clean up**: kill sessions without asking; remove log files at your own discretion

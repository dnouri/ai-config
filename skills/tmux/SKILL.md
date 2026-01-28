---
name: tmux
description: Run dev servers, background tasks, or any long-running process in tmux sessions. Use instead of nohup or & with bash tool.
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

**For interactive tools** (REPLs, prompts), capture the current screen:
```bash
tmux capture-pane -t <name> -p
```

Allow ~0.5 seconds after starting a session before reading output.

## Stop a Session

```bash
tmux kill-session -t <name>
```

## Send Input

If a process needs input:
```bash
tmux send-keys -t <name> "input text" Enter
```

**Special keys:** `Enter`, `Escape`, `C-c` (Ctrl+C), `C-d` (Ctrl+D), `Up`, `Down`, `Space`, `BSpace` (backspace)

**Note:** Keys are separate arguments, not escape sequences. Use `"text" Enter`, not `"text\n"`.

## Rules

1. **Always redirect output** to `/tmp/pi-tmux-<name>.log` so you can read it later
2. **Use descriptive session names** - they're easier to manage than PIDs
3. **Check `tmux ls`** before creating sessions to avoid name conflicts
4. **Always clean up**: kill sessions without asking; remove log files at your own discretion

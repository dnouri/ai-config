# dnopi

Skills and extensions for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), compatible with Claude Code, Codex CLI, and other harnesses.

## Installation

Clone and symlink skills to your agent's skills directory:

```bash
git clone https://github.com/dnouri/ai-config ~/dnouri-ai-config

# pi-coding-agent
ln -s ~/dnouri-ai-config/skills/linear ~/.pi/agent/skills/linear
ln -s ~/dnouri-ai-config/skills/aws-sso ~/.pi/agent/skills/aws-sso
ln -s ~/dnouri-ai-config/skills/tmux ~/.pi/agent/skills/tmux
ln -s ~/dnouri-ai-config/skills/slack-latest ~/.pi/agent/skills/slack-latest

# Claude Code
ln -s ~/dnouri-ai-config/skills/linear ~/.claude/skills/linear
ln -s ~/dnouri-ai-config/skills/aws-sso ~/.claude/skills/aws-sso
ln -s ~/dnouri-ai-config/skills/tmux ~/.claude/skills/tmux
ln -s ~/dnouri-ai-config/skills/slack-latest ~/.claude/skills/slack-latest
```

## AGENTS.md / CLAUDE.md

`AGENTS.md` is the global agent instructions file — the single source of truth for how AI coding agents should behave across all projects. `CLAUDE.md` is a symlink to `AGENTS.md`, so both tools read the same file.

**Where they're loaded from:**

| Tool | Global location | How to install |
|------|----------------|----------------|
| **pi** | `~/.pi/agent/AGENTS.md` | `ln -s ~/dnouri-ai-config/AGENTS.md ~/.pi/agent/AGENTS.md` |
| **Claude Code** | `~/.claude/CLAUDE.md` | `ln -s ~/dnouri-ai-config/CLAUDE.md ~/.claude/CLAUDE.md` |

Both tools also support project-level files (`./AGENTS.md` / `./CLAUDE.md`) that override or extend the global one. The global file here covers methodology (TDD, pair programming), commit discipline, testing standards, and Python guidelines.

## Skills

| Skill | Description |
|-------|-------------|
| [linear](skills/linear/SKILL.md) | Linear issue management with linearis CLI |
| [aws-sso](skills/aws-sso/SKILL.md) | AWS SSO token re-authentication |
| [tmux](skills/tmux/SKILL.md) | Run long-running processes in tmux sessions |
| [slack-latest](skills/slack-latest/SKILL.md) | Gather recent Slack messages, read threads, and send replies |

## Extensions (pi only)

| Extension | Description |
|-----------|-------------|
| [notify.ts](extensions/notify.ts) | Desktop notification when agent needs attention |
| [pisay.ts](extensions/pisay.ts) | π mascot — extension UI protocol test harness (`/pisay help`) |

## Requirements

- **linear**: [linearis](https://github.com/czottmann/linearis) (`npm install -g linearis`) and a [Linear API token](https://linear.app/settings/account/security)
- **aws-sso**: [AWS CLI](https://aws.amazon.com/cli/) and [tmux](https://github.com/tmux/tmux)
- **tmux**: [tmux](https://github.com/tmux/tmux)
- **slack-latest**: Python 3 (standard library only); browser tokens from a Slack session

## License

MIT

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

# Claude Code
ln -s ~/dnouri-ai-config/skills/linear ~/.claude/skills/linear
ln -s ~/dnouri-ai-config/skills/aws-sso ~/.claude/skills/aws-sso
ln -s ~/dnouri-ai-config/skills/tmux ~/.claude/skills/tmux
```

## Skills

| Skill | Description |
|-------|-------------|
| [linear](skills/linear/SKILL.md) | Linear issue management with linearis CLI |
| [aws-sso](skills/aws-sso/SKILL.md) | AWS SSO token re-authentication |
| [tmux](skills/tmux/SKILL.md) | Run long-running processes in tmux sessions |

## Extensions (pi only)

| Extension | Description |
|-----------|-------------|
| [notify.ts](extensions/notify.ts) | Desktop notification when agent needs attention |

## Requirements

- **linear**: [linearis](https://github.com/czottmann/linearis) (`npm install -g linearis`) and a [Linear API token](https://linear.app/settings/account/security)
- **aws-sso**: [AWS CLI](https://aws.amazon.com/cli/) and [tmux](https://github.com/tmux/tmux)
- **tmux**: [tmux](https://github.com/tmux/tmux)

## License

MIT

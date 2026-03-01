# dnopi

6 skills and 2 extensions for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Installation

Install all 6 skills and 2 extensions:

```bash
pi install npm:dnopi
```

Or pick what you want via [settings filtering](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md#package-filtering) in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "npm:dnopi",
      "extensions": ["extensions/notify.ts"],
      "skills": ["skills/tmux"]
    }
  ]
}
```

Arrays support globs and `!exclusions`. Omit a key to load all of that type; use `[]` to load none.

## AGENTS.md / CLAUDE.md

`AGENTS.md` is the global agent instructions file — the single source of truth for how AI coding agents should behave across all projects. `CLAUDE.md` is a symlink to `AGENTS.md`, so both tools read the same file.

| Tool | Global location | How to install |
|------|----------------|----------------|
| **pi** | `~/.pi/agent/AGENTS.md` | `ln -s <repo>/AGENTS.md ~/.pi/agent/AGENTS.md` |
| **Claude Code** | `~/.claude/CLAUDE.md` | `ln -s <repo>/CLAUDE.md ~/.claude/CLAUDE.md` |

Both tools also support project-level files (`./AGENTS.md` / `./CLAUDE.md`) that override or extend the global one. The global file here covers methodology (TDD, pair programming), commit discipline, testing standards, and Python guidelines.

## Skills

| Skill | Description |
|-------|-------------|
| [linear](skills/linear/SKILL.md) | Linear issue management with linearis CLI |
| [aws-sso](skills/aws-sso/SKILL.md) | AWS SSO token re-authentication |
| [tmux](skills/tmux/SKILL.md) | Run long-running processes in tmux sessions |
| [slack-latest](skills/slack-latest/SKILL.md) | Gather recent Slack messages, read threads, and send replies |
| [improve-agents-md](skills/improve-agents-md/SKILL.md) | Analyze pi sessions to find recurring issues and fix AGENTS.md (pi-specific) |
| [web-search](skills/web-search/SKILL.md) | Web search and content extraction via Brave/DuckDuckGo (no API keys needed) |

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
- **improve-agents-md**: Python 3, [jq](https://jqlang.github.io/jq/) (for raw JSONL investigation); pi sessions only
- **web-search**: [Node.js](https://nodejs.org/) (runs `npm install` on first use); optionally [`playwright-cli`](https://github.com/microsoft/playwright-cli) for JavaScript-heavy pages — see [setup guide](skills/web-search/references/setup-playwright.md)

## License

MIT

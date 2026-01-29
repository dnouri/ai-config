---
name: linear
description: "Manage Linear issues with linearis CLI. List issues, create issues, update status, link GitHub PRs, search."
---

# Linear Issue Management

Track your work, link PRs to issues, update status as you code. This skill connects your coding workflow (especially `gh` CLI) with Linear issue tracking.

Run `linearis usage` to see all available commands. All output is JSON.

## Installation

```bash
npm install -g linearis
```

## Setup

Check if authentication is configured:

```bash
# Check file first (preferred)
cat ~/.linear_api_token 2>/dev/null || echo "No token file"

# Or environment variable
echo $LINEAR_API_TOKEN
```

If neither exists, guide the user:

1. Create API key at https://linear.app/settings/account/security
2. Save it (file is simplest):
   ```bash
   echo "lin_api_..." > ~/.linear_api_token
   ```
   Or add to shell profile: `export LINEAR_API_TOKEN="lin_api_..."`

## Useful Context

On first use, fetch user context to enable filtering by assignee and team:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_TOKEN" \
  -d '{"query": "{ viewer { id name teamMemberships { nodes { team { key name } } } } }"}' | jq
```

This gives you:
- **User ID** - for `--assignee` filtering ("show MY issues")
- **Teams** - keys like `ENG`, `DEV` for `--team` filtering

Also fetch available labels:

```bash
linearis labels list | jq '.labels[].name'
```

Keep this context for the session.

## My Issues

The daily driver. Show issues assigned to the user, filtered by status.

```bash
# Active work (in progress + todo)
linearis issues search "" --assignee <user-id> --status "In Progress,Todo"

# Just what's in progress
linearis issues search "" --assignee <user-id> --status "In Progress"

# Scoped to a team
linearis issues search "" --assignee <user-id> --status "In Progress,Todo" --team ENG
```

Present results clearly: issue ID, title, status, team.

## Link PR to Issue

When the user creates a PR with `gh`, link it to the Linear issue. This connects code to tracking.

```bash
# After: gh pr create ...
linearis comments create ENG-123 --body "PR: https://github.com/org/repo/pull/456"

# Or dynamically:
linearis comments create ENG-123 --body "PR: $(gh pr view --json url -q .url)"
```

Offer this automatically when a PR is created and the branch or context suggests a Linear issue.

## Create Issue

Quick capture of new work. The `--team` flag is required.

```bash
# Simple
linearis issues create "Fix login timeout" --team ENG -d "Users report session expires"

# With labels and priority (1=urgent, 4=low)
linearis issues create "Fix login timeout" --team ENG \
  -d "Users report session expires too quickly" \
  --labels "Bug" --priority 1

# Multi-line description using bash $'...' syntax
linearis issues create "Refactor auth module" --team ENG \
  -d $'## Problem\n\nAuth code is tangled.\n\n## Proposal\n\nExtract to separate service.'

# Sub-issue (use --parent-ticket)
linearis issues create "Write auth tests" --team ENG --parent-ticket ENG-123
```

Before creating, consider searching to check for duplicates.

## Update Status

Track progress as work moves through stages.

```bash
# Starting work
linearis issues update ENG-123 --status "In Progress"

# PR opened
linearis issues update ENG-123 --status "In Review"

# Done
linearis issues update ENG-123 --status "Done"
```

Combine with PR workflow: when PR merges, offer to mark issue as Done.

## Read Issue

Get full context before starting work: description, comments, relationships.

```bash
linearis issues read ENG-123
```

Summarize key information: title, status, assignee, description, recent comments, parent/child issues.

## Search

Find issues by keyword across the workspace.

```bash
# Broad search (all teams)
linearis issues search "authentication"

# Scoped to team
linearis issues search "authentication" --team ENG

# Filter by status
linearis issues search "bug" --status "In Progress,Todo"
```

Note: searching without `--team` searches ALL workspace teams, not just the user's teams.

## List Projects

See active initiatives and their status.

```bash
linearis projects list
```

Projects can be used with `--project` when creating issues or filtering searches.

## Add Comment

Add context, findings, or updates to an issue.

```bash
linearis comments create ENG-123 --body "Investigated - root cause is in the session handler"
```

## Rules

1. **Always check LINEAR_API_TOKEN** before running commands
2. **Fetch workspace context** on first Linear interaction (user ID, teams, labels)
3. **Use --assignee with user ID** to filter "my" issues
4. **--team is required** for creating issues
5. **Link PRs to issues** - offer this when gh pr create succeeds
6. **Search before creating** - avoid duplicate issues
7. **Present JSON output clearly** - format as readable summaries, not raw JSON dumps

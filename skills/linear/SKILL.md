---
name: linear
description: "Manage Linear issues: Create issues, update issues, search issues. Best when combined with GitHub CLI"
---

# Linear Issue Management

Track your work, link PRs to issues, update issues as you progress.

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

## Necessary Context

Before you use this skill for anything, run `linearis usage` to get an overview of all available commands. Note that linearis output is always JSON.

On first use, also fetch user context to enable filtering by assignee and team:

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

## Link PR to Issue

**Always link PRs to Linear issues**: this creates traceability and auto-updates issue status when PRs merge.

Linear's GitHub integration handles this automatically when the issue ID appears in your branch name or PR title. [Setup guide](https://linear.app/docs/github-integration)

### Start With the Issue ID in Your Branch

When you begin work on an issue in a branch, make sure to bake the issue ID into your branch name:

```bash
# Get the branch name from Linear (includes issue ID)
linearis issues read ENG-123 | jq -r '.branchName'
# → feature/eng-123-fix-login-timeout

# Create the branch
git checkout -b $(linearis issues read ENG-123 | jq -r '.branchName')
```

### Include the Issue ID When Creating PRs

Reinforce the link by including the issue ID in your PR:

```bash
# Use magic "Closes" in the PR body
gh pr create --title "Fix login timeout" --body "Description here...

Closes ENG-123"
```

### Fallback: Link Retroactively via Comment

Already created a PR without the issue ID? Link it manually:

```bash
linearis comments create ENG-123 --body "PR: $(gh pr view --json url -q .url)"
```

## My Issues

The daily driver. Show issues assigned to the user, filtered by status.

```bash
# Active work (in progress + todo)
linearis issues search "" --assignee <user-id> --status "In Progress,Todo"

# Only in progress, scoped to the ENG team
linearis issues search "" --assignee <user-id> --status "In Progress" --team ENG
```

Present results clearly: issue ID, title, status, team.

## Create Issue

Quick capture of new work. The `--team` flag is required.

```bash
# Simple (assigned to yourself)
linearis issues create "Fix login timeout" --team ENG -a <user-id> -d "Users report session expires"

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

Before creating, search to check for duplicates, and broader context.

## Track Progress

Keep issues in sync with your work. Read issues before writing: never lose information.

### Check Current State

Before updating, understand what's there:

```bash
# Full issue with description and comments
linearis issues read ENG-123
```

Summarize key information: title, status, assignee, description, recent comments, parent/child issues.

### Update Status

Move issues through workflow stages:

```bash
linearis issues update ENG-123 --status "In Progress"
linearis issues update ENG-123 --status "In Review"
linearis issues update ENG-123 --status "Done"
```

### Update Description (Checkboxes, Sections)

To update issues, update progress, checkboxes, assumptions, you must use a sequence of read → modify → write to ensure you don't lose information or details.

Use these three commands in sequence:

```bash
# Get a fresh view of issue and comments
linearis issues read ENG-123

# Modify whatever after you read
linear issues update ENG-123 --description "My new description..."
```

You can also add updates via commenting:

```bash
# Progress note
linearis comments create ENG-123 --body "This issue doesn't make any sense, sorry"
```

**Use comments when:**
- Reporting incremental progress
- Adding investigation notes
- Linking external resources (PRs, docs, logs)

**Use description updates when:**
- Checking off task checkboxes
- Updating acceptance criteria
- Correcting original assumptions

Combine updates to issue description and adding comments as you see fit.

## Search

Search issues by title and description:

```bash
# Search by keyword (returns array, not object with .issues)
linearis issues search "login timeout" --team ENG | jq -r '.[] | "\(.identifier) [\(.state.name)] \(.title)"'
```

**Fallback if keyword search returns nothing:** List all team issues, then filter locally:
```bash
# Step 1: Fetch all team issues to a temp file
linearis issues search "" --team ENG > /tmp/issues.json

# Step 2: List identifier, title, status
jq -r '.[] | "\(.identifier) [\(.state.name)] \(.title)"' /tmp/issues.json

# Step 3: Read the specific issue you need
linearis issues read ENG-123
```

Note: searching without `--team` searches ALL workspace teams.

## List Projects

See active initiatives and their status.

```bash
linearis projects list
```

Projects can be used with `--project` when creating issues or filtering searches.

## Rules

1. **Always check LINEAR_API_TOKEN** before running commands
2. **Fetch workspace context** on first Linear interaction (user ID, teams, labels)
3. **Use --assignee with user ID** to filter "my" issues
4. **--team is required** for creating issues
5. **Link PRs to issues** - offer this when gh pr create succeeds
6. **Search before creating** - avoid duplicate issues
7. **Present JSON output clearly** - format as readable summaries, not raw JSON dumps

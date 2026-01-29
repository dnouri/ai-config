---
name: aws-sso
description: Use when AWS CLI commands fail with SSO token expiration errors like "Token has expired", "SSO session has expired", or "Error when retrieving credentials".
---

# AWS SSO Re-Authentication

This skill handles AWS SSO token expiration. Use it when AWS commands fail with authentication errors.

## Detect Auth Failure

Trigger this skill when you see errors like:
- `Token has expired and refresh failed`
- `The SSO session has expired`
- `Error when retrieving credentials`
- `The SSO access token has expired`

## Re-Authentication Flow

### Step 1: Start login in tmux

Run the login command in a tmux session with `--no-browser` to capture the URL:

```bash
tmux new-session -d -s aws-sso 'aws sso login --profile <profile-name> --no-browser > /tmp/pi-tmux-aws-sso.log 2>&1'
```

### Step 2: Wait briefly, then read the URL

```bash
sleep 1
cat /tmp/pi-tmux-aws-sso.log
```

The output will contain:
```
Browser will not be automatically opened.
Please visit the following URL:

https://oidc.<region>.amazonaws.com/authorize?...
```

### Step 3: Present URL to user

Show the user the URL and ask them to complete authentication:

```
⚠️ AWS SSO token expired for profile `<profile-name>`.

Please open this URL in your browser to authenticate:
<url>

Let me know when you've completed the login.
```

### Step 4: Verify authentication

After user confirms, check if login succeeded:

```bash
cat /tmp/pi-tmux-aws-sso.log
```

Look for `Successfully logged into Start URL:` in the output.

Then verify credentials work:

```bash
aws sts get-caller-identity --profile <profile-name>
```

### Step 5: Clean up

```bash
tmux kill-session -t aws-sso 2>/dev/null
rm -f /tmp/pi-tmux-aws-sso.log
```

## List Available Profiles

```bash
grep '^\[profile' ~/.aws/config | sed 's/\[profile \(.*\)\]/\1/'
```

## Check Token Status

```bash
aws sts get-caller-identity --profile <profile-name> 2>&1
```

## Rules

1. **Only use this skill for auth failures** - not for general AWS work
2. **Always use `--no-browser`** - lets us capture and show the URL
3. **Use tmux** - keeps the login process running independently
4. **Wait for user confirmation** - never retry automatically after auth failure
5. **Be specific** about which profile needs login
6. **Clean up** the tmux session and log file when done

# Browser Setup for Web Search

Walk the user through these steps in order. Each step says who acts — **you** (the LLM) or **the user** (in their browser). Run commands, show results, and guide the user through manual steps with clear context.

## Prerequisites

**You run:**

```bash
playwright-cli --version
```

If `playwright-cli` is not found, install it first (see the playwright-cli skill). Then detect available browsers:

```bash
for b in /opt/brave.com/brave/brave /usr/bin/google-chrome /usr/bin/chromium /usr/bin/microsoft-edge; do
  [ -f "$b" ] && echo "FOUND: $b ($($b --version 2>/dev/null | head -1))"
done
```

Tell the user which browsers were found. If multiple, recommend Brave (built-in ad blocking produces cleaner results). Let them choose. Remember the chosen `<BROWSER_PATH>` for later steps.

## Step 1: Create the automation profile

A dedicated browser profile keeps automation isolated from the user's personal browser — no tab flashing, no exposure of banking/email sessions, and a clean environment for web searches.

**You run:**

```bash
mkdir -p ~/.config/web-search/ai-web-search-profile
```

## Step 2: Install the Playwright MCP Bridge extension

Launch the browser with the automation profile and navigate to the extension page.

**Ask the user:** *"Please launch <BROWSER_NAME> with the dedicated automation profile by running this in your terminal:*

```bash
<BROWSER_PATH> --user-data-dir=$HOME/.config/web-search/ai-web-search-profile \
  "https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm" &
```

*A fresh browser window will open (no bookmarks or history — that's expected). Click **'Add to Chrome'** (or 'Add to Brave') and confirm. Let me know when it's done."*

**Wait for user confirmation.**

If the user already has the extension installed in this profile, skip to Step 3.

## Step 3: Get the extension token

**Ask the user:** *"Now I need the extension's authentication token. In the automation browser:*

1. *Click the **puzzle piece icon** (🧩) in the toolbar — that's the extensions menu*
2. *Click **'Playwright MCP Bridge'** to open its status page*
3. *You'll see a line like `PLAYWRIGHT_MCP_EXTENSION_TOKEN=abc123...`*
4. *Copy and paste that whole line (or just the part after `=`) here"*

**Wait for the user to paste the token.** Extract the token value (the part after `=` if they pasted the whole line).

If the user has trouble finding the extension icon: *"Try clicking the three-dot menu → Extensions → Playwright MCP Bridge."*

## Step 4: Write the config file

**You run** (substituting the actual values):

```bash
mkdir -p ~/.config/web-search
cat > ~/.config/web-search/config.json << 'EOF'
{
  "extensionToken": "<TOKEN>",
  "browser": {
    "browserName": "chromium",
    "userDataDir": "~/.config/web-search/ai-web-search-profile",
    "launchOptions": {
      "executablePath": "<BROWSER_PATH>"
    }
  }
}
EOF
```

Replace `<TOKEN>` with the token from Step 3 and `<BROWSER_PATH>` with the browser path from Prerequisites.

The `~` in `userDataDir` is expanded automatically; absolute paths also work.

## Step 5: Close the automation browser

**Ask the user:** *"Please close the automation browser window that we opened in Step 2. The skill launches it automatically — having it already running causes connection timeouts."*

**Wait for user confirmation.**

## Step 6: Verify the setup

**You run:**

```bash
{baseDir}/web.js verify
```

This tests the full pipeline: load config → launch browser → connect via extension → navigate → extract content → close. On success you'll see `"Setup verified"`.

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| Config file not found | Config doesn't exist yet | Run through this guide from Step 1 |
| Missing `userDataDir` | Config lacks automation profile | Add `browser.userDataDir` to config (Step 4) |
| Missing `executablePath` | Browser path not set | Add `browser.launchOptions.executablePath` to config (Step 4) |
| Missing `extensionToken` | Token not set in config | Re-do Step 3, update config |
| Extension connection timeout | Automation browser is already running | Close the automation browser, then retry (Step 5) |
| Extension connection timeout | Extension not installed in automation profile | Re-do Step 2 with the automation profile |
| Invalid token | Token mismatch between config and extension | Re-do Step 3 — get the token from the *automation profile's* extension |
| Browser executable not found | Wrong path in config | Fix `executablePath` in config (Step 4) |

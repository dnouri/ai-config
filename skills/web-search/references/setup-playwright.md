# Playwright Fallback Setup

The web-search skill can optionally use [`playwright-cli`](https://github.com/microsoft/playwright-cli) to extract content from JavaScript-rendered pages (SPAs). Without it, search and plain HTTP content extraction still work fine — this is only needed when a page requires a real browser to render.

## Install playwright-cli

```bash
npm install -g @playwright/cli@latest
playwright-cli --help   # verify it's on PATH
```

## Configure the browser

Create `~/.playwright/cli.config.json` to set your browser and executable path:

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "executablePath": "/usr/bin/chromium",
      "headless": true
    }
  }
}
```

Adjust `browserName` (`chromium`, `firefox`, `webkit`) and `executablePath` to match your system. If you omit `executablePath`, Playwright uses its own bundled browser — download it with:

```bash
npx playwright install chromium
```

On Linux, Chromium may need system libraries (libgbm, libasound2, etc.). Install them with:

```bash
npx playwright install-deps chromium
```

## Verify

```bash
playwright-cli open https://example.com
playwright-cli close
```

If you see the page snapshot, you're good. If you get errors about missing libraries, re-run `npx playwright install-deps chromium`.

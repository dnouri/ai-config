import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { parsePlaywrightResult, buildSessionEnv, sessionName, connectionError, browserPidFile, reapStaleResources } from "./session.js";

describe("parsePlaywrightResult", () => {
	test("extracts JSON string from playwright-cli output", () => {
		const output = `### Result\n"Example Domain"\n### Ran Playwright code`;
		assert.equal(parsePlaywrightResult(output), "Example Domain");
	});

	test("extracts JSON array from output", () => {
		const output = `### Result\n[{"title":"Test"}]\n### Ran Playwright code`;
		assert.deepEqual(parsePlaywrightResult(output), [{ title: "Test" }]);
	});

	test("extracts JSON object from output", () => {
		const output = `### Result\n{"key":"value"}\n### Ran Playwright code`;
		assert.deepEqual(parsePlaywrightResult(output), { key: "value" });
	});

	test("parses multi-line pretty-printed JSON", () => {
		const output = [
			"### Result",
			"[",
			"  {",
			'    "a": 1',
			"  },",
			"  {",
			'    "a": 2',
			"  }",
			"]",
			"### Ran Playwright code",
		].join("\n");
		assert.deepEqual(parsePlaywrightResult(output), [{ a: 1 }, { a: 2 }]);
	});

	test("returns null for output without JSON", () => {
		const output = `### Page\n- Page URL: https://example.com\n`;
		assert.equal(parsePlaywrightResult(output), null);
	});

	test("returns number result", () => {
		const output = `### Result\n42\n### Ran Playwright code`;
		assert.equal(parsePlaywrightResult(output), 42);
	});

	test("returns boolean result", () => {
		const output = `### Result\ntrue\n### Ran Playwright code`;
		assert.equal(parsePlaywrightResult(output), true);
	});

	test("returns null result", () => {
		const output = `### Result\nnull\n### Ran Playwright code`;
		assert.equal(parsePlaywrightResult(output), null);
	});

	test("returns null for empty result section", () => {
		const output = `### Result\n\n### Ran Playwright code`;
		assert.equal(parsePlaywrightResult(output), null);
	});
});

describe("buildSessionEnv", () => {
	test("includes PLAYWRIGHT_MCP_EXTENSION_TOKEN from config", () => {
		const config = { extensionToken: "my-token", browser: {} };
		const env = buildSessionEnv(config);
		assert.equal(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, "my-token");
	});

	test("preserves existing PATH", () => {
		const config = { extensionToken: "tok", browser: {} };
		const env = buildSessionEnv(config);
		assert.equal(env.PATH, process.env.PATH);
	});

	test("wraps the configured browser so web-search owns its lifecycle", () => {
		const config = {
			extensionToken: "tok",
			browser: {
				userDataDir: "/home/user/.config/web-search/profile",
				launchOptions: { executablePath: "/opt/brave/brave" },
			},
		};
		const env = buildSessionEnv(config);

		assert.notEqual(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH, "/opt/brave/brave");
		const wrapper = readFileSync(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH, "utf-8");
		assert.match(wrapper, /\/opt\/brave\/brave/);
		assert.match(wrapper, /--user-data-dir=\/home\/user\/\.config\/web-search\/profile/);
		assert.doesNotMatch(wrapper, /--headless=new/);
	});

	test("sets PLAYWRIGHT_MCP_USER_DATA_DIR from expanded config", () => {
		const config = {
			extensionToken: "tok",
			browser: { userDataDir: "/home/user/.config/web-search/profile" },
		};
		const env = buildSessionEnv(config);
		assert.equal(env.PLAYWRIGHT_MCP_USER_DATA_DIR, "/home/user/.config/web-search/profile");
	});

	test("omits PLAYWRIGHT_MCP_USER_DATA_DIR when userDataDir is not set", () => {
		const config = { extensionToken: "tok", browser: {} };
		const env = buildSessionEnv(config);
		assert.equal(env.PLAYWRIGHT_MCP_USER_DATA_DIR, undefined);
	});

	test("wraps executablePath with headless launcher when headless is true", () => {
		const config = {
			extensionToken: "tok",
			browser: { launchOptions: { headless: true, executablePath: "/opt/brave/brave" } },
		};
		const env = buildSessionEnv(config);

		// Should point to a generated wrapper, not the original binary
		assert.ok(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH);
		assert.notEqual(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH, "/opt/brave/brave");

		// Wrapper should exist and contain --headless=new and the real path
		const wrapper = readFileSync(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH, "utf-8");
		assert.match(wrapper, /--headless=new/);
		assert.match(wrapper, /\/opt\/brave\/brave/);
	});

});

describe("browserPidFile", () => {
	test("returns a path for every managed browser", () => {
		const config = {
			browser: { launchOptions: { executablePath: "/opt/brave/brave" } },
		};
		const pidFile = browserPidFile(config);
		assert.ok(pidFile);
		assert.match(pidFile, /web-search-browser-.*\/browser\.pid$/);
	});

	test("returns null without a configured executable", () => {
		assert.equal(browserPidFile({ browser: { launchOptions: {} } }), null);
	});
});

describe("browser wrapper writes PID file", () => {
	test("wrapper records PID before exec", () => {
		const config = {
			extensionToken: "tok",
			browser: { launchOptions: { executablePath: "/opt/brave/brave" } },
		};
		const env = buildSessionEnv(config);
		const wrapper = readFileSync(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH, "utf-8");
		const pidFile = browserPidFile(config);

		assert.match(wrapper, /echo \$\$ >/);
		assert.ok(wrapper.indexOf("echo $$") < wrapper.indexOf("exec "));
		assert.ok(wrapper.includes(pidFile), `wrapper should reference pid file ${pidFile}`);
	});
});

describe("connectionError", () => {
	test("wraps error with clear message and BROWSER_UNAVAILABLE code", () => {
		const raw = new Error("Command failed");
		const wrapped = connectionError(raw);
		assert.match(wrapped.message, /Could not connect to the automation browser/);
		assert.match(wrapped.message, /setup-browser\.md/);
		assert.equal(wrapped.code, "BROWSER_UNAVAILABLE");
	});

	test("suggests closing browser when stderr mentions timeout", () => {
		const raw = new Error("Command failed");
		raw.stderr = "Error: timeout 15000ms exceeded";
		const wrapped = connectionError(raw);
		assert.match(wrapped.message, /already be running/);
	});

	test("suggests installation check when stderr has no timeout", () => {
		const raw = new Error("Command failed");
		raw.stderr = "ENOENT: no such file or directory";
		const wrapped = connectionError(raw);
		assert.match(wrapped.message, /extension are installed/);
	});

	test("handles missing stderr", () => {
		const raw = new Error("Command failed");
		const wrapped = connectionError(raw);
		assert.match(wrapped.message, /extension are installed/);
	});
});

describe("sessionName", () => {
	test("returns a string starting with web-search-", () => {
		const name = sessionName();
		assert.match(name, /^web-search-/);
	});

	test("returns unique names on successive calls", () => {
		const a = sessionName();
		const b = sessionName();
		assert.notEqual(a, b);
	});
});

describe("reapStaleResources", () => {
	const deadPid = 99999999; // PID that certainly doesn't exist
	const staleDir = join(tmpdir(), `web-search-browser-${deadPid}`);

	afterEach(() => {
		try { rmSync(staleDir, { recursive: true, force: true }); } catch {}
	});

	test("removes tmp directory from a dead process", () => {
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(join(staleDir, "browser-launcher"), "#!/bin/sh\n");
		assert.ok(existsSync(staleDir));

		reapStaleResources();

		assert.ok(!existsSync(staleDir), "stale dir should be removed");
	});

	test("removes tmp directory with PID file from a dead process", () => {
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(join(staleDir, "browser-launcher"), "#!/bin/sh\n");
		writeFileSync(join(staleDir, "browser.pid"), "88888888\n"); // also dead

		reapStaleResources();

		assert.ok(!existsSync(staleDir), "stale dir with PID file should be removed");
	});

	test("does not touch directory owned by current process", () => {
		const ownDir = join(tmpdir(), `web-search-browser-${process.pid}`);
		mkdirSync(ownDir, { recursive: true });
		writeFileSync(join(ownDir, "browser-launcher"), "#!/bin/sh\n");

		reapStaleResources();

		assert.ok(existsSync(ownDir), "own directory should be left alone");
		rmSync(ownDir, { recursive: true, force: true });
	});

	test("removes stale daemon session files from dead processes", () => {
		const daemonBase = join(homedir(), ".cache", "ms-playwright", "daemon");
		// Find an existing hash dir, or create a test one
		const hashDir = join(daemonBase, "test-reap-hash");
		mkdirSync(hashDir, { recursive: true });

		const staleSession = join(hashDir, `web-search-${deadPid}-0.session`);
		writeFileSync(staleSession, "");
		assert.ok(existsSync(staleSession));

		reapStaleResources();

		assert.ok(!existsSync(staleSession), "stale session file should be removed");
		rmSync(hashDir, { recursive: true, force: true });
	});

	test("does not remove session files owned by the current process", () => {
		const daemonBase = join(homedir(), ".cache", "ms-playwright", "daemon");
		const hashDir = join(daemonBase, "test-reap-hash");
		mkdirSync(hashDir, { recursive: true });

		const ownSession = join(hashDir, `web-search-${process.pid}-0.session`);
		writeFileSync(ownSession, "");

		reapStaleResources();

		assert.ok(existsSync(ownSession), "own session file should be left alone");
		rmSync(hashDir, { recursive: true, force: true });
	});
});

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { parsePlaywrightResult, buildSessionEnv, sessionName, connectionError } from "./session.js";

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

	test("sets PLAYWRIGHT_MCP_EXECUTABLE_PATH from expanded config", () => {
		const config = {
			extensionToken: "tok",
			browser: { launchOptions: { executablePath: "/opt/brave/brave" } },
		};
		const env = buildSessionEnv(config);
		assert.equal(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH, "/opt/brave/brave");
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

	test("does not wrap executablePath when headless is false or unset", () => {
		const noHeadless = {
			extensionToken: "tok",
			browser: { launchOptions: { executablePath: "/usr/bin/chromium" } },
		};
		assert.equal(
			buildSessionEnv(noHeadless).PLAYWRIGHT_MCP_EXECUTABLE_PATH,
			"/usr/bin/chromium",
		);

		const explicitFalse = {
			extensionToken: "tok",
			browser: { launchOptions: { headless: false, executablePath: "/usr/bin/chromium" } },
		};
		assert.equal(
			buildSessionEnv(explicitFalse).PLAYWRIGHT_MCP_EXECUTABLE_PATH,
			"/usr/bin/chromium",
		);
	});
});

describe("connectionError", () => {
	test("wraps error with clear message", () => {
		const raw = new Error("Command failed");
		const wrapped = connectionError(raw);
		assert.match(wrapped.message, /Could not connect to the automation browser/);
		assert.match(wrapped.message, /setup-browser\.md/);
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

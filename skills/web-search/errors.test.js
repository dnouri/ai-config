import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SearchError, WebSearchBusyError, formatError } from "./errors.js";

// ---------------------------------------------------------------------------
// SearchError
// ---------------------------------------------------------------------------

describe("SearchError", () => {
	test("extends Error with message", () => {
		const err = new SearchError("captcha detected", {
			category: "captcha",
			engine: "brave",
			query: "test query",
		});
		assert.ok(err instanceof Error);
		assert.equal(err.message, "captcha detected");
	});

	test("has name SearchError", () => {
		const err = new SearchError("x", { category: "captcha" });
		assert.equal(err.name, "SearchError");
	});

	test("stores category, engine, and query", () => {
		const err = new SearchError("blocked", {
			category: "blocked",
			engine: "ddg",
			query: "python async",
		});
		assert.equal(err.category, "blocked");
		assert.equal(err.engine, "ddg");
		assert.equal(err.query, "python async");
	});
});

// ---------------------------------------------------------------------------
// WebSearchBusyError
// ---------------------------------------------------------------------------

describe("WebSearchBusyError", () => {
	test("uses a retry-after-60-seconds message without profile paths", () => {
		const err = new WebSearchBusyError({
			profileHash: "abc123",
			ownerPid: 1234,
			ownerOperation: "search",
			requestedOperation: "content",
		});

		assert.equal(err.code, "WEB_SEARCH_BUSY");
		assert.match(err.message, /Retry this command after about 60 seconds/);
		assert.match(err.message, /Profile.*abc123/);
		assert.match(err.message, /Owner PID/);
		assert.ok(!err.message.includes("userDataDir"));
	});
});

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

describe("formatError", () => {
	test("formats plain error with markdown heading", () => {
		const output = formatError(new Error("something broke"));
		assert.match(output, /^# Error\n/);
		assert.ok(output.includes("something broke"));
	});

	test("uses Search Error: Captcha heading for captcha category", () => {
		const err = new SearchError("captcha detected", {
			category: "captcha",
			engine: "brave",
			query: "test",
		});
		const output = formatError(err);
		assert.match(output, /^# Search Error: Captcha\n/);
	});

	test("uses Search Error: Blocked heading for blocked category", () => {
		const err = new SearchError("bot detection triggered", {
			category: "blocked",
			engine: "ddg",
			query: "test",
		});
		const output = formatError(err);
		assert.match(output, /^# Search Error: Blocked\n/);
	});

	test("uses Web Search Busy heading for profile lock contention", () => {
		const output = formatError(new WebSearchBusyError({ profileHash: "abc123" }));
		assert.match(output, /^# Web Search Busy\n/);
		assert.match(output, /Retry this command after about 60 seconds/);
	});

	test("includes bold session info when sessionName is present", () => {
		const err = new Error("captcha detected");
		err.sessionName = "web-search-123-0";
		const output = formatError(err);
		assert.match(output, /\*\*Session `web-search-123-0` is still open\*\*/);
		assert.match(output, /playwright-cli -s web-search-123-0 snapshot/);
	});

	test("includes How to resolve heading with resolution steps", () => {
		const err = new Error("test");
		err.sessionName = "ws-1";
		const output = formatError(err);
		assert.match(output, /## How to resolve/);
		assert.match(output, /playwright-cli -s ws-1 detach/);
	});

	test("includes retry command with query for SearchError", () => {
		const err = new SearchError("captcha", {
			category: "captcha",
			engine: "brave",
			query: "python tutorial",
		});
		err.sessionName = "ws-1";
		const output = formatError(err, "/path/to/skill");
		assert.match(output, /web\.js search "python tutorial"/);
	});

	test("suggests alternate engines from err.alternatives", () => {
		const err = new SearchError("captcha", {
			category: "captcha",
			engine: "brave",
			query: "test",
		});
		err.sessionName = "ws-1";
		err.alternatives = ["google", "ddg", "bing"];
		const output = formatError(err, "/path");
		assert.match(output, /--engine google/);
		assert.match(output, /--engine bing/);
		assert.match(output, /--engine ddg/);
		assert.ok(!output.includes("--engine brave"));
	});

	test("omits engine suggestions when no alternatives set", () => {
		const err = new SearchError("blocked", {
			category: "blocked",
			engine: "ddg",
			query: "test",
		});
		err.sessionName = "ws-1";
		const output = formatError(err, "/path");
		assert.ok(!output.includes("--engine"));
	});

	test("omits session section when no sessionName", () => {
		const err = new SearchError("no results", {
			category: "captcha",
			engine: "brave",
			query: "test",
		});
		const output = formatError(err);
		assert.ok(!output.includes("Session"));
		assert.ok(!output.includes("playwright-cli"));
	});

	test("uses baseDir in retry command", () => {
		const err = new SearchError("x", {
			category: "captcha",
			engine: "brave",
			query: "q",
		});
		err.sessionName = "ws-1";
		const output = formatError(err, "/home/user/skills/web-search");
		assert.match(output, /\/home\/user\/skills\/web-search\/web\.js/);
	});
});

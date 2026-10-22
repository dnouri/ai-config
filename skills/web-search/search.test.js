import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
	braveSearchUrl, ddgSearchUrl, googleSearchUrl, bingSearchUrl,
	isCaptchaTitle, isDdgBlocked, isGoogleBlocked, isBingBlocked,
	ENGINES, DEFAULT_ENGINE_ORDER,
	formatResults, parseSearchArgs,
} from "./search.js";

// Execute the real browser expressions against an offline DOM. JSDOM does not
// load external resources or run page scripts with these default options.
function domSession(html, url = "https://www.google.com/search?q=test") {
	const document = new JSDOM(html, { url }).window.document;
	return {
		pageTitle: () => document.title,
		eval: expr => Function("document", `return (${expr})()`)(document),
	};
}

function googleResultHtml(href, title = "Result", snippet = "A result snippet") {
	return `<div class="tF2Cxc">
		<a jsname="UWckNb" href="${href}"><h3>${title}</h3></a>
		<div class="VwiC3b">${snippet}</div>
	</div>`;
}

describe("braveSearchUrl", () => {
	test("encodes query into Brave Search URL", () => {
		assert.equal(
			braveSearchUrl("hello world"),
			"https://search.brave.com/search?q=hello%20world&source=web",
		);
	});

	test("encodes special characters", () => {
		const url = braveSearchUrl("c++ std::vector");
		assert.ok(url.includes("c%2B%2B"));
	});
});

describe("ddgSearchUrl", () => {
	test("encodes query into DuckDuckGo HTML URL", () => {
		assert.equal(
			ddgSearchUrl("hello world"),
			"https://html.duckduckgo.com/html/?q=hello%20world",
		);
	});
});

describe("googleSearchUrl", () => {
	test("encodes query into Google Search URL", () => {
		assert.equal(
			googleSearchUrl("hello world"),
			"https://www.google.com/search?q=hello%20world",
		);
	});
});

describe("bingSearchUrl", () => {
	test("encodes query into Bing Search URL", () => {
		assert.equal(
			bingSearchUrl("hello world"),
			"https://www.bing.com/search?q=hello%20world",
		);
	});
});

describe("isGoogleBlocked", () => {
	test("detects unusual traffic message", () => {
		assert.ok(isGoogleBlocked("Our systems have detected unusual traffic from your computer"));
	});

	test("detects sorry page", () => {
		assert.ok(isGoogleBlocked("Sorry, we need to verify that you're not a robot"));
	});

	test("returns false for normal body", () => {
		assert.ok(!isGoogleBlocked("JavaScript async patterns - Google Search"));
	});

	test("handles null/undefined", () => {
		assert.ok(!isGoogleBlocked(null));
		assert.ok(!isGoogleBlocked(undefined));
	});
});

describe("isBingBlocked", () => {
	test("detects captcha page", () => {
		assert.ok(isBingBlocked("<div id=\"b_captcha\">Please verify</div>"));
	});

	test("detects unusual traffic", () => {
		assert.ok(isBingBlocked("We detected unusual traffic from your network"));
	});

	test("returns false for normal content", () => {
		assert.ok(!isBingBlocked("javascript test runner - Search"));
	});

	test("handles null/undefined", () => {
		assert.ok(!isBingBlocked(null));
		assert.ok(!isBingBlocked(undefined));
	});
});

describe("Google result extraction", () => {
	test("retains relative and absolute goto result links as unresolved redirects", () => {
		// Minimal reconstruction of the 2026-10-02 saved result attributes and
		// snapshot. Tokens are synthetic opaque values, not encoded destinations.
		const session = domSession(
			googleResultHtml(
				"/goto?url=opaque-first",
				"Your First Ten Hires Are AI Agents: The Solo Founder's ...",
				"Aug 05, 2026. Your First Ten Hires Are AI Agents.",
			) + googleResultHtml(
				"https://www.google.com/goto?url=opaque-second&amp;ved=example",
				"Software Engineer, Coding Agent Harness Engineering",
				"Applications for this job will be accepted at least until September 19, 2026.",
			),
		);

		assert.deepEqual(session.eval(ENGINES.google.extractExpr(10)), [
			{
				title: "Your First Ten Hires Are AI Agents: The Solo Founder's ...",
				link: "https://www.google.com/goto?url=opaque-first",
				snippet: "Aug 05, 2026. Your First Ten Hires Are AI Agents.",
				needsResolution: true,
			},
			{
				title: "Software Engineer, Coding Agent Harness Engineering",
				link: "https://www.google.com/goto?url=opaque-second&ved=example",
				snippet: "Applications for this job will be accepted at least until September 19, 2026.",
				needsResolution: true,
			},
		]);
	});

	test("still rejects Google navigation, help and unsupported redirect routes", () => {
		const links = [
			"/search?q=test", "/webhp", "/preferences?hl=sv",
			"https://support.google.com/websearch/answer/181196?hl=sv",
			"https://accounts.google.com/ServiceLogin",
			"https://policies.google.com/privacy?hl=sv",
			"/goto", "/goto?url=", "/goto?url=%20", "/goto/other?url=opaque",
			"https://support.google.com/goto?url=opaque",
			"http://www.google.com/goto?url=opaque",
		];
		const session = domSession(links.map(link => googleResultHtml(link)).join(""));
		assert.deepEqual(session.eval(ENGINES.google.extractExpr(20)), []);
	});

	test("preserves direct links and the yuRUbf anchor fallback", () => {
		const session = domSession(`<div class="tF2Cxc">
			<div class="yuRUbf"><a href="https://example.com/agents"><h3>Agent harness</h3></a></div>
			<div class="VwiC3b"> A direct result </div>
		</div>`);
		assert.deepEqual(session.eval(ENGINES.google.extractExpr(10)), [
			{ title: "Agent harness", link: "https://example.com/agents", snippet: "A direct result" },
		]);
	});

	test("deduplicates result hrefs and applies the limit to accepted results", () => {
		const redirect = googleResultHtml("/goto?url=opaque-first", "Redirect");
		const session = domSession(
			googleResultHtml("/search?q=test") + redirect + redirect +
			googleResultHtml("https://example.com/agents", "Direct") +
			googleResultHtml("/goto?url=opaque-second", "Second redirect"),
		);
		assert.deepEqual(session.eval(ENGINES.google.extractExpr(2)), [
			{
				title: "Redirect", link: "https://www.google.com/goto?url=opaque-first",
				snippet: "A result snippet", needsResolution: true,
			},
			{ title: "Direct", link: "https://example.com/agents", snippet: "A result snippet" },
		]);
	});

	test("skips non-HTTP, malformed and untitled results", () => {
		const session = domSession(
			["javascript:alert(1)", "mailto:test@example.com", "http://"]
				.map(link => googleResultHtml(link)).join("") +
			googleResultHtml("/goto?url=opaque-untitled", ""),
		);
		assert.deepEqual(session.eval(ENGINES.google.extractExpr(10)), []);
	});
});

describe("Brave blocking detection", () => {
	test("classifies the saved proof-of-work wall despite its normal title", () => {
		// Heading, controls and help route from the 2026-10-02 saved snapshot.
		const session = domSession(`<title>Brave Search</title><body>
			<h1>Verifying you're not a bot</h1>
			<p>Quick check before you continue searching.</p>
			<button>Verify</button><button>Switch to traditional CAPTCHA</button>
			<a href="/help/pow-captcha">Why am I seeing this?</a>
		</body>`, "https://search.brave.com/search?q=test&source=web");
		assert.deepEqual(ENGINES.brave.detectBlocking(session), {
			category: "captcha", message: "Brave Search is requesting bot verification",
		});
	});

	test("does not classify ordinary results mentioning bot verification as a wall", () => {
		const session = domSession(`<title>bot verification - Brave Search</title>
			<div data-type="web"><a href="https://example.com/captcha">
				<span class="title">CAPTCHA help</span></a>
				<p>What does Verifying you're not a bot mean? An article about CAPTCHA.</p>
			</div>`, "https://search.brave.com/search?q=test&source=web");
		assert.equal(ENGINES.brave.detectBlocking(session), null);
	});

	test("preserves title-based challenge classification", () => {
		const session = domSession("<title>PoW Captcha - Brave Search</title>");
		assert.deepEqual(ENGINES.brave.detectBlocking(session), {
			category: "captcha",
			message: 'Brave Search showed a captcha (page title: "PoW Captcha - Brave Search")',
		});
	});
});

describe("ENGINES", () => {
	test("has entries for all four engines", () => {
		assert.ok(ENGINES.google);
		assert.ok(ENGINES.bing);
		assert.ok(ENGINES.ddg);
		assert.ok(ENGINES.brave);
	});

	test("each engine has required interface", () => {
		for (const [id, engine] of Object.entries(ENGINES)) {
			assert.equal(typeof engine.name, "string", `${id}.name`);
			assert.equal(typeof engine.searchUrl, "function", `${id}.searchUrl`);
			assert.equal(typeof engine.extractExpr, "function", `${id}.extractExpr`);
			assert.equal(typeof engine.detectBlocking, "function", `${id}.detectBlocking`);
		}
	});

	test("engine names are human-readable", () => {
		assert.equal(ENGINES.google.name, "Google");
		assert.equal(ENGINES.bing.name, "Bing");
		assert.equal(ENGINES.ddg.name, "DuckDuckGo");
		assert.equal(ENGINES.brave.name, "Brave Search");
	});
});

describe("DEFAULT_ENGINE_ORDER", () => {
	test("starts with google and ends with bing", () => {
		assert.equal(DEFAULT_ENGINE_ORDER[0], "google");
		assert.equal(DEFAULT_ENGINE_ORDER[DEFAULT_ENGINE_ORDER.length - 1], "bing");
	});

	test("contains all four engines", () => {
		assert.deepEqual(DEFAULT_ENGINE_ORDER, ["google", "ddg", "brave", "bing"]);
	});
});

describe("isCaptchaTitle", () => {
	test("detects Brave captcha title", () => {
		assert.ok(isCaptchaTitle("PoW Captcha - Brave Search"));
	});

	test("detects robot check", () => {
		assert.ok(isCaptchaTitle("Are you a Robot?"));
	});

	test("detects blocked page", () => {
		assert.ok(isCaptchaTitle("Access Blocked"));
	});

	test("returns false for normal search title", () => {
		assert.ok(!isCaptchaTitle("test query - Brave Search"));
	});

	test("handles null/undefined", () => {
		assert.ok(!isCaptchaTitle(null));
		assert.ok(!isCaptchaTitle(undefined));
	});
});

describe("isDdgBlocked", () => {
	test("detects robot check in body", () => {
		assert.ok(isDdgBlocked("Please confirm you're not a robot"));
	});

	test("detects anomaly modal", () => {
		assert.ok(isDdgBlocked("anomaly-modal"));
	});

	test("detects bot message", () => {
		assert.ok(isDdgBlocked("bots use DuckDuckGo too"));
	});

	test("returns false for normal body", () => {
		assert.ok(!isDdgBlocked("JavaScript async patterns"));
	});

	test("handles null/undefined", () => {
		assert.ok(!isDdgBlocked(null));
		assert.ok(!isDdgBlocked(undefined));
	});
});

describe("formatResults", () => {
	test("labels unresolved redirects without implying content verifies the destination", () => {
		const output = formatResults([
			{
				title: "Redirect", link: "https://www.google.com/goto?url=opaque",
				snippet: "Search snippet", needsResolution: true, content: "Extracted content",
			},
			{ title: "Direct", link: "https://example.com/agents", snippet: "Direct snippet" },
		], { query: "agent harness", engine: "google" });
		assert.equal(output, [
			'# Search: "agent harness"', "", "Found 2 results via Google.", "",
			"## 1. Redirect", "", "**URL:** https://www.google.com/goto?url=opaque",
			"**Link status:** Search redirect; destination not yet resolved or verified.", "",
			"Search snippet", "", "Extracted content", "",
			"## 2. Direct", "", "**URL:** https://example.com/agents", "", "Direct snippet",
		].join("\n"));
	});

	test("formats single result as markdown with heading and metadata", () => {
		const output = formatResults(
			[{ title: "Test Page", link: "https://example.com", snippet: "A test page" }],
			{ query: "test", engine: "brave" },
		);
		assert.match(output, /^# Search: "test"/);
		assert.match(output, /Found 1 result via Brave Search\./);
		assert.match(output, /## 1\. Test Page/);
		assert.match(output, /\*\*URL:\*\* https:\/\/example\.com/);
		assert.ok(output.includes("A test page"));
	});

	test("uses Google engine name from registry", () => {
		const output = formatResults(
			[{ title: "Test", link: "https://a.com", snippet: "S" }],
			{ query: "q", engine: "google" },
		);
		assert.match(output, /Found 1 result via Google\./);
	});

	test("uses Bing engine name from registry", () => {
		const output = formatResults(
			[{ title: "Test", link: "https://a.com", snippet: "S" }],
			{ query: "q", engine: "bing" },
		);
		assert.match(output, /Found 1 result via Bing\./);
	});

	test("formats multiple results with sequential numbering", () => {
		const output = formatResults(
			[
				{ title: "First", link: "https://a.com", snippet: "A" },
				{ title: "Second", link: "https://b.com", snippet: "B" },
			],
			{ query: "multi", engine: "ddg" },
		);
		assert.match(output, /Found 2 results via DuckDuckGo\./);
		assert.match(output, /## 1\. First/);
		assert.match(output, /## 2\. Second/);
	});

	test("includes content when present", () => {
		const output = formatResults(
			[{ title: "Page", link: "https://a.com", snippet: "S", content: "# Heading\nBody text" }],
			{ query: "q", engine: "brave" },
		);
		assert.ok(output.includes("# Heading\nBody text"));
		assert.ok(!output.includes("Content:"));
	});

	test("omits content section when absent", () => {
		const output = formatResults(
			[{ title: "Page", link: "https://a.com", snippet: "S" }],
			{ query: "q", engine: "brave" },
		);
		assert.ok(!output.includes("# Heading"));
	});
});

describe("parseSearchArgs", () => {
	test("defaults to no engine preference", () => {
		const result = parseSearchArgs(["hello", "world"]);
		assert.equal(result.query, "hello world");
		assert.equal(result.count, 10);
		assert.equal(result.withContent, false);
		assert.equal(result.engine, null);
	});

	test("parses -n flag", () => {
		const result = parseSearchArgs(["test", "-n", "5"]);
		assert.equal(result.query, "test");
		assert.equal(result.count, 5);
	});

	test("caps -n at 20", () => {
		const result = parseSearchArgs(["test", "-n", "50"]);
		assert.equal(result.count, 20);
	});

	test("defaults invalid -n to 10", () => {
		const result = parseSearchArgs(["test", "-n", "abc"]);
		assert.equal(result.count, 10);
	});

	test("parses --content flag", () => {
		const result = parseSearchArgs(["test", "--content"]);
		assert.equal(result.withContent, true);
		assert.equal(result.query, "test");
	});

	test("parses --engine ddg", () => {
		const result = parseSearchArgs(["test", "--engine", "ddg"]);
		assert.equal(result.engine, "ddg");
	});

	test("parses --engine google", () => {
		const result = parseSearchArgs(["test", "--engine", "google"]);
		assert.equal(result.engine, "google");
	});

	test("parses --engine bing", () => {
		const result = parseSearchArgs(["test", "--engine", "bing"]);
		assert.equal(result.engine, "bing");
	});

	test("rejects unknown engine", () => {
		const result = parseSearchArgs(["test", "--engine", "yahoo"]);
		assert.equal(result.engine, null);
	});

	test("parses all flags combined", () => {
		const result = parseSearchArgs(["js", "async", "-n", "3", "--content", "--engine", "ddg"]);
		assert.equal(result.query, "js async");
		assert.equal(result.count, 3);
		assert.equal(result.withContent, true);
		assert.equal(result.engine, "ddg");
	});

	test("returns empty query when no args", () => {
		const result = parseSearchArgs([]);
		assert.equal(result.query, "");
	});
});

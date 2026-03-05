import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	extractReadable, toMarkdown, isBrowserErrorUrl,
	isBrowserErrorContent, formatJsonContent,
	isExtractableContentType,
} from "./content.js";

// ---------------------------------------------------------------------------
// toMarkdown
// ---------------------------------------------------------------------------

describe("toMarkdown", () => {
	test("converts heading", () => {
		assert.equal(toMarkdown("<h1>Hello</h1>"), "# Hello");
	});

	test("converts paragraph", () => {
		assert.equal(toMarkdown("<p>Some text</p>"), "Some text");
	});

	test("converts link", () => {
		assert.equal(
			toMarkdown('<a href="https://example.com">click</a>'),
			"[click](https://example.com)",
		);
	});

	test("removes empty links", () => {
		assert.equal(
			toMarkdown('<a href="https://example.com"></a><p>text</p>'),
			"text",
		);
	});

	test("converts code block", () => {
		const html = "<pre><code>const x = 1;</code></pre>";
		assert.match(toMarkdown(html), /```\nconst x = 1;\n```/);
	});

	test("converts table with GFM", () => {
		const html = `
			<table>
				<thead><tr><th>A</th><th>B</th></tr></thead>
				<tbody><tr><td>1</td><td>2</td></tr></tbody>
			</table>`;
		const md = toMarkdown(html);
		assert.match(md, /\| A \| B \|/);
		assert.match(md, /\| 1 \| 2 \|/);
	});

	test("collapses excessive whitespace", () => {
		const md = toMarkdown("<p>hello</p>\n\n\n\n\n<p>world</p>");
		assert.ok(!md.includes("\n\n\n"));
	});
});

// ---------------------------------------------------------------------------
// extractReadable
// ---------------------------------------------------------------------------

describe("extractReadable", () => {
	test("extracts article content with title", () => {
		const html = `<html><head><title>My Article</title></head><body>
			<article>
				<h1>My Article</h1>
				<p>This is a paragraph with enough content to be considered readable.
				It needs to be long enough for Readability to consider it worthwhile.
				Here is some more text to make it substantial enough for extraction.
				And even more text because Readability has a minimum content threshold.</p>
				<p>Another paragraph with additional details about the topic at hand.
				This helps establish that the content is a real article worth reading.</p>
			</article>
		</body></html>`;

		const result = extractReadable(html, "https://example.com/article");
		assert.ok(result, "expected non-null result");
		assert.ok(result.title, "expected a title");
		assert.ok(result.markdown.length > 50, "expected substantial markdown");
		assert.ok(result.markdown.includes("paragraph"), "expected content preserved");
	});

	test("falls back to main content when Readability fails", () => {
		// Minimal page that Readability will likely reject but has a <main> element
		const html = `<html><head><title>Sparse Page</title></head><body>
			<nav><a href="/">Home</a><a href="/about">About</a></nav>
			<main>
				<p>This is the main content area with enough text to be worth extracting.
				It should survive the fallback extraction path even when Readability
				decides the page doesn't have a proper article structure. We need enough
				characters here to pass the 100-character threshold.</p>
			</main>
			<footer>Copyright 2026</footer>
		</body></html>`;

		const result = extractReadable(html, "https://example.com/sparse");
		assert.ok(result, "expected non-null result from fallback");
		assert.ok(result.markdown.includes("main content area"));
		// Nav and footer should be stripped in fallback
		assert.ok(!result.markdown.includes("Copyright 2026"));
	});

	test("returns null for nearly empty page", () => {
		const html = `<html><body><p>Hi</p></body></html>`;
		const result = extractReadable(html, "https://example.com/empty");
		assert.equal(result, null);
	});

	test("strips script and style tags in fallback", () => {
		const html = `<html><head><title>Test</title></head><body>
			<script>alert('xss')</script>
			<style>.hidden { display: none }</style>
			<main><p>This is the real content that should be preserved after stripping
			out scripts, styles, and other non-content elements. It needs to be long
			enough to pass the minimum length threshold for extraction.</p></main>
		</body></html>`;

		const result = extractReadable(html, "https://example.com/scripts");
		if (result) {
			assert.ok(!result.markdown.includes("alert"));
			assert.ok(!result.markdown.includes("display: none"));
		}
	});
});

// ---------------------------------------------------------------------------
// Browser error detection
// ---------------------------------------------------------------------------

describe("isBrowserErrorUrl", () => {
	test("detects chrome-error:// URL", () => {
		assert.ok(isBrowserErrorUrl("chrome-error://chromewebdata/"));
	});

	test("returns false for normal URL", () => {
		assert.ok(!isBrowserErrorUrl("https://example.com"));
	});

	test("handles null/undefined", () => {
		assert.ok(!isBrowserErrorUrl(null));
		assert.ok(!isBrowserErrorUrl(undefined));
	});
});

describe("isBrowserErrorContent", () => {
	test("detects ERR_NAME_NOT_RESOLVED", () => {
		assert.ok(isBrowserErrorContent("<html><body>ERR_NAME_NOT_RESOLVED</body></html>"));
	});

	test("detects 'This site can't be reached'", () => {
		assert.ok(isBrowserErrorContent("<html><body>This site can't be reached</body></html>"));
	});

	test("detects ERR_CONNECTION_REFUSED", () => {
		assert.ok(isBrowserErrorContent("<html><body>ERR_CONNECTION_REFUSED</body></html>"));
	});

	test("returns false for normal HTML", () => {
		assert.ok(!isBrowserErrorContent("<html><body><p>Normal page content</p></body></html>"));
	});
});

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

describe("isExtractableContentType", () => {
	test("accepts text/html", () => {
		assert.ok(isExtractableContentType("text/html"));
	});

	test("accepts text/plain", () => {
		assert.ok(isExtractableContentType("text/plain"));
	});

	test("accepts application/json", () => {
		assert.ok(isExtractableContentType("application/json"));
	});

	test("accepts application/xhtml+xml", () => {
		assert.ok(isExtractableContentType("application/xhtml+xml"));
	});

	test("rejects image/png", () => {
		assert.ok(!isExtractableContentType("image/png"));
	});

	test("rejects image/jpeg", () => {
		assert.ok(!isExtractableContentType("image/jpeg"));
	});

	test("rejects application/pdf", () => {
		assert.ok(!isExtractableContentType("application/pdf"));
	});

	test("rejects video/mp4", () => {
		assert.ok(!isExtractableContentType("video/mp4"));
	});

	test("rejects application/octet-stream", () => {
		assert.ok(!isExtractableContentType("application/octet-stream"));
	});

	test("assumes extractable when null/undefined", () => {
		assert.ok(isExtractableContentType(null));
		assert.ok(isExtractableContentType(undefined));
	});
});

// ---------------------------------------------------------------------------
// JSON formatting
// ---------------------------------------------------------------------------

describe("formatJsonContent", () => {
	test("pretty-prints valid JSON", () => {
		const json = '{"userId":1,"id":1,"title":"hello"}';
		const result = formatJsonContent(json);
		assert.match(result, /```json/);
		assert.match(result, /"userId": 1/);
		assert.match(result, /```\s*$/);
	});

	test("returns raw text when JSON is invalid", () => {
		const text = "not json at all";
		const result = formatJsonContent(text);
		assert.equal(result, "not json at all");
	});

	test("handles JSON array", () => {
		const json = '[{"a":1},{"a":2}]';
		const result = formatJsonContent(json);
		assert.match(result, /```json/);
		assert.match(result, /"a": 1/);
	});
});

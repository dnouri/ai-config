/**
 * Content extraction: HTML → readable markdown.
 */

import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// Suppress JSDOM CSS parsing warnings (modern CSS features like :is(), :has(),
// @layer trigger "Could not parse CSS stylesheet" on every <style> block).
const quietConsole = new VirtualConsole();

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
td.use(gfm);
td.addRule("removeEmptyLinks", {
	filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
	replacement: () => "",
});

/**
 * Chromium error page indicators.
 * ERR_* codes are locale-independent. English text strings are secondary
 * signals — primary detection uses isBrowserErrorUrl (chrome-error:// URL).
 */
const BROWSER_ERROR_PATTERNS = [
	"ERR_NAME_NOT_RESOLVED",
	"ERR_CONNECTION_REFUSED",
	"ERR_CONNECTION_TIMED_OUT",
	"ERR_CERT_DATE_INVALID",
	"ERR_CERT_AUTHORITY_INVALID",
	"ERR_CERT_COMMON_NAME_INVALID",
	"ERR_EMPTY_RESPONSE",
	"ERR_SSL_PROTOCOL_ERROR",
	"This site can't be reached",
	"This page isn't working",
	"Your connection is not private",
];

/**
 * Minimum markdown length to consider content worth returning.
 * Filters out near-empty pages and pages where Readability or fallback
 * extraction produces only navigation remnants or boilerplate.
 */
const MIN_CONTENT_LENGTH = 100;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an HTML fragment to markdown.
 *
 * Uses Turndown with GFM plugin for tables/strikethrough, fenced code blocks,
 * and ATX headings. Strips empty links and collapses excessive whitespace.
 */
export function toMarkdown(html) {
	return td
		.turndown(html)
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/ +/g, " ")
		.replace(/\s+([,.])/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Extract readable content from a full HTML document.
 *
 * First tries Mozilla Readability (best for articles). Falls back to
 * stripping boilerplate (scripts, styles, nav, header, footer, aside)
 * and converting the main content area.
 *
 * @param {string} html - Full document HTML (outerHTML)
 * @param {string} url - Page URL (for relative link resolution)
 * @returns {{ title: string|null, markdown: string } | null}
 */
export function extractReadable(html, url) {
	const doc = new JSDOM(html, { url, virtualConsole: quietConsole }).window.document;
	const article = new Readability(doc).parse();

	if (article?.content) {
		const markdown = toMarkdown(article.content);
		if (markdown.length > MIN_CONTENT_LENGTH) {
			return { title: article.title || null, markdown };
		}
	}

	// Fallback: strip boilerplate, try main content area.
	// Must re-parse because Readability mutates the document in-place.
	const doc2 = new JSDOM(html, { url, virtualConsole: quietConsole }).window.document;
	for (const el of doc2.querySelectorAll("script, style, noscript, nav, header, footer, aside")) {
		el.remove();
	}

	const title = doc2.querySelector("title")?.textContent?.trim() || null;
	const main =
		doc2.querySelector("main, article, [role='main'], .content, #content") || doc2.body;
	const content = main?.innerHTML || "";

	return content.trim().length > MIN_CONTENT_LENGTH
		? { title, markdown: toMarkdown(content) }
		: null;
}

/**
 * Check if a URL indicates a browser error page.
 */
export function isBrowserErrorUrl(url) {
	if (!url) return false;
	return url.startsWith("chrome-error://");
}

/**
 * Check if HTML content contains browser error indicators.
 */
export function isBrowserErrorContent(html) {
	if (!html) return false;
	return BROWSER_ERROR_PATTERNS.some((p) => html.includes(p));
}

/**
 * Content types from which we can extract readable text.
 * Everything else (images, PDFs, video, binary) is rejected.
 */
const EXTRACTABLE_TYPES = ["text/", "application/json", "application/xml", "application/xhtml"];

/**
 * Check if a content type is extractable (text, JSON, XML, HTML).
 * Returns false for images, PDFs, video, audio, and other binary types.
 */
export function isExtractableContentType(contentType) {
	if (!contentType) return true; // assume HTML if unknown
	const ct = contentType.toLowerCase();
	return EXTRACTABLE_TYPES.some((t) => ct.includes(t));
}

/**
 * Format raw JSON text as a markdown code block.
 *
 * If the text is valid JSON, pretty-prints it inside a fenced code block.
 * Otherwise returns the raw text unchanged.
 */
export function formatJsonContent(text) {
	try {
		const parsed = JSON.parse(text);
		return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
	} catch {
		return text;
	}
}

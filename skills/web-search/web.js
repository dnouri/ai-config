#!/usr/bin/env node

import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

// Suppress JSDOM CSS parsing errors (modern CSS features like :is(), :has(), @layer
// trigger "Could not parse CSS stylesheet" on every <style> block).
const quietConsole = new VirtualConsole();
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const PW_CONFIG = join(homedir(), ".playwright", "cli.config.json");

const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
td.use(gfm);
td.addRule("removeEmptyLinks", {
	filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
	replacement: () => "",
});

// Content-Type allowlist for fetchable content
const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "application/json"];

// Playwright session counter for unique session names (avoids EADDRINUSE)
let pwSessionId = 0;

// Browser error page indicators (from Chromium)
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

// HTTP status codes that should NOT be retried (client errors, not transient)
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 405, 410, 414, 451]);

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

async function withRetry(fn, { retries = 2, baseDelay = 2000, label = "operation" } = {}) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (e) {
			if (attempt >= retries) throw e;
			// Don't retry non-transient errors
			if (e.nonRetryable || e.needsBrowser) throw e;
			const delay = baseDelay * 2 ** attempt;
			console.error(`${label}: attempt ${attempt + 1} failed (${e.message}), retrying in ${delay}ms...`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const [cmd, ...argv] = process.argv.slice(2);

try {
	if (cmd === "search") await search(argv);
	else if (cmd === "content") await content(argv);
	else usage(cmd);
} catch (e) {
	console.error(`Error: ${e.message}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function search(argv) {
	const args = [...argv];

	const ci = args.indexOf("--content");
	const withContent = ci !== -1;
	if (withContent) args.splice(ci, 1);

	let count = 10;
	const ni = args.indexOf("-n");
	if (ni !== -1) {
		const parsed = parseInt(args[ni + 1], 10);
		count = Math.min(Number.isNaN(parsed) || parsed < 1 ? 10 : parsed, 20);
		args.splice(ni, 2);
	}

	const query = args.join(" ").trim();
	if (!query) {
		console.error("Usage: web.js search <query> [-n <num>] [--content]");
		process.exit(1);
	}

	const results = await fetchResults(query, count);

	if (!results.length) {
		console.error("No results found.");
		process.exit(0);
	}

	if (withContent) {
		const CONCURRENCY = 3;
		await parallelMap(results, (r) => fetchContent(r.link).then((c) => (r.content = c)), CONCURRENCY);
	}

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		console.log(`--- Result ${i + 1} ---`);
		console.log(`Title: ${r.title}`);
		console.log(`Link: ${r.link}`);
		console.log(`Snippet: ${r.snippet}`);
		if (r.content) console.log(`Content:\n${r.content}`);
		console.log("");
	}
}

async function content(argv) {
	const url = argv[0];
	if (!url) {
		console.error("Usage: web.js content <url>");
		process.exit(1);
	}

	const result = await fetchContentWithFallback(url);

	if (!result) {
		console.error("Could not extract readable content.");
		process.exit(1);
	}

	if (result.title) console.log(`# ${result.title}\n`);
	console.log(result.markdown);
}

function usage(cmd) {
	console.error(
		`Usage: web.js <command> [options]

Commands:
  search <query> [-n <num>] [--content]    Search the web
  content <url>                             Extract page content as markdown

Options:
  -n <num>      Number of results (default: 10, max: 20)
  --content     Fetch and include page content from result URLs

Examples:
  web.js search "python asyncio best practices"
  web.js search "rust error handling" -n 10 --content
  web.js content https://docs.example.com/guide`,
	);
	process.exit(cmd ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Search: Brave primary, DuckDuckGo fallback (both with retry)
// ---------------------------------------------------------------------------

async function fetchResults(query, max) {
	// Try Brave first (more reliable)
	try {
		return await fetchBraveResults(query, max);
	} catch (e) {
		console.error(`Brave search failed (${e.message}), trying DuckDuckGo...`);
	}

	// Fallback to DuckDuckGo
	return fetchDDGResults(query, max);
}

async function fetchDDGResults(query, max) {
	return withRetry(
		async () => {
			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

			const res = await fetch(url, {
				headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
				signal: AbortSignal.timeout(10000),
			});

			if (!res.ok) {
				const err = new Error(`HTTP ${res.status}`);
				if (NON_RETRYABLE_STATUSES.has(res.status)) err.nonRetryable = true;
				throw err;
			}

			const text = await res.text();
			const doc = new JSDOM(text, { url, virtualConsole: quietConsole }).window.document;
			const body = doc.body?.textContent || "";

			if (body.includes("not a robot") || body.includes("bots use DuckDuckGo") ||
				body.includes("anomaly-modal") || text.includes("anomaly-modal")) {
				throw new Error("Bot detection triggered");
			}

			const results = [];

			for (const el of doc.querySelectorAll(".result")) {
				if (results.length >= max) break;

				const a = el.querySelector(".result__a");
				if (!a) continue;

				let link = a.getAttribute("href") || "";
				if (link.includes("uddg=")) {
					try {
						link = decodeURIComponent(
							new URL(link, "https://duckduckgo.com").searchParams.get("uddg") || link,
						);
					} catch {}
				}
				if (!link.startsWith("http") || link.includes("duckduckgo.com/y.js")) continue;

				results.push({
					title: a.textContent?.trim() || "",
					link,
					snippet: el.querySelector(".result__snippet")?.textContent?.trim() || "",
				});
			}

			return results;
		},
		{ retries: 1, baseDelay: 2000, label: "DDG" },
	);
}

async function fetchBraveResults(query, max) {
	return withRetry(
		async () => {
			const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;

			const res = await fetch(url, {
				headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
				signal: AbortSignal.timeout(10000),
			});

			if (!res.ok) {
				const err = new Error(`HTTP ${res.status}`);
				if (NON_RETRYABLE_STATUSES.has(res.status)) err.nonRetryable = true;
				throw err;
			}

			const doc = new JSDOM(await res.text(), { url, virtualConsole: quietConsole }).window.document;
			const results = [];

			for (const el of doc.querySelectorAll('[data-type="web"]')) {
				if (results.length >= max) break;

				const a = el.querySelector("a[href]");
				const href = a?.getAttribute("href") || "";
				if (!href.startsWith("http")) continue;

				const title = el.querySelector(".title")?.textContent?.trim() || "";
				if (!title) continue;

				const snippet = el.querySelector(".snippet-description, .generic-snippet .content")?.textContent?.trim() || "";

				results.push({ title, link: href, snippet });
			}

			return results;
		},
		{ retries: 1, baseDelay: 2000, label: "Brave" },
	);
}

// ---------------------------------------------------------------------------
// Content extraction (with retry + playwright fallback)
// ---------------------------------------------------------------------------

async function fetchContent(url) {
	try {
		const result = await fetchContentWithFallback(url);
		return result ? result.markdown : "(Could not extract content)";
	} catch (e) {
		return `(Error: ${e.message})`;
	}
}

async function fetchContentWithFallback(url) {
	// Try fetch + Readability first (with retry, only on transient errors)
	const result = await withRetry(
		async () => {
			const res = await fetch(url, {
				headers: {
					"User-Agent": UA,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "en-US,en;q=0.9",
				},
				signal: AbortSignal.timeout(15000),
			});

			if (!res.ok) {
				const err = new Error(`HTTP ${res.status}: ${res.statusText}`);
				if (NON_RETRYABLE_STATUSES.has(res.status)) err.nonRetryable = true;
				throw err;
			}

			// Check Content-Type before reading body
			const ct = (res.headers.get("content-type") || "").toLowerCase();
			const allowed = ALLOWED_CONTENT_TYPES.some((t) => ct.includes(t));
			if (!allowed && ct) {
				const err = new Error(`Unsupported content type: ${ct}`);
				err.nonRetryable = true;
				throw err;
			}

			const body = await res.text();

			// Handle non-HTML text content types
			if (ct.includes("application/json")) {
				try {
					return { title: null, markdown: "```json\n" + JSON.stringify(JSON.parse(body), null, 2) + "\n```" };
				} catch {
					return { title: null, markdown: body };
				}
			}
			if (ct.includes("text/plain")) {
				return { title: null, markdown: body };
			}

			const extracted = extractReadable(body, url);
			if (!extracted) {
				const err = new Error("Could not extract readable content (page may require JavaScript)");
				err.needsBrowser = true;
				throw err;
			}
			return extracted;
		},
		{ retries: 1, baseDelay: 2000, label: `Fetch ${url}` },
	).catch((e) => {
		// Don't fall back to playwright for non-retryable (4xx, bad content-type) errors
		if (e.nonRetryable && !e.needsBrowser) {
			console.error(`${e.message}`);
			return null;
		}
		return undefined; // signal: proceed to playwright fallback
	});

	if (result !== undefined) return result;

	// Fallback: use playwright-cli for JS-rendered content
	console.error(`Falling back to playwright-cli for ${url}`);
	return fetchWithPlaywright(url);
}

function fetchWithPlaywright(url) {
	const session = `fetch-${process.pid}-${pwSessionId++}`;
	try {
		execFileSync("playwright-cli", ["-s", session, "open", `--config=${PW_CONFIG}`, url], {
			stdio: "pipe",
			timeout: 20000,
		});

		// Check if browser landed on an error page (chrome-error://)
		const pageUrl = parsePlaywrightString(
			execFileSync("playwright-cli", ["-s", session, "eval", "window.location.href"], {
				encoding: "utf-8",
				timeout: 5000,
			}),
		);
		if (pageUrl?.startsWith("chrome-error://")) {
			console.error("Playwright landed on a browser error page.");
			return null;
		}

		const raw = execFileSync("playwright-cli", ["-s", session, "eval", "document.documentElement.outerHTML"], {
			maxBuffer: 10 * 1024 * 1024,
			encoding: "utf-8",
			timeout: 10000,
		});

		const html = parsePlaywrightString(raw);
		if (!html) return null;

		// Detect browser error pages by content (fallback for non-chrome-error:// pages)
		if (isBrowserErrorPage(html)) {
			console.error("Playwright rendered a browser error page, not real content.");
			return null;
		}

		return extractReadable(html, url);
	} catch (e) {
		console.error(`Playwright fallback failed: ${e.message}`);
		return null;
	} finally {
		try {
			execFileSync("playwright-cli", ["-s", session, "close"], { stdio: "pipe", timeout: 5000 });
		} catch {}
	}
}

/**
 * Parse a JSON-encoded string from playwright-cli output.
 * Finds the first line starting with '"' and JSON-parses it.
 */
function parsePlaywrightString(raw) {
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith('"')) {
			try {
				return JSON.parse(trimmed);
			} catch {}
		}
	}
	return null;
}

function isBrowserErrorPage(html) {
	return BROWSER_ERROR_PATTERNS.some((p) => html.includes(p));
}

// ---------------------------------------------------------------------------
// Readability + markdown conversion
// ---------------------------------------------------------------------------

function extractReadable(html, url) {
	const article = new Readability(new JSDOM(html, { url, virtualConsole: quietConsole }).window.document).parse();

	if (article?.content) {
		return { title: article.title || null, markdown: toMarkdown(article.content) };
	}

	const doc = new JSDOM(html, { url, virtualConsole: quietConsole }).window.document;
	for (const el of doc.querySelectorAll("script, style, noscript, nav, header, footer, aside")) {
		el.remove();
	}

	const title = doc.querySelector("title")?.textContent?.trim() || null;
	const main =
		doc.querySelector("main, article, [role='main'], .content, #content") || doc.body;
	const content = main?.innerHTML || "";

	return content.trim().length > 100
		? { title, markdown: toMarkdown(content) }
		: null;
}

function toMarkdown(html) {
	return td
		.turndown(html)
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/ +/g, " ")
		.replace(/\s+([,.])/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ---------------------------------------------------------------------------
// Concurrency-limited parallel map
// ---------------------------------------------------------------------------

async function parallelMap(items, fn, concurrency) {
	const results = [];
	let i = 0;

	async function worker() {
		while (i < items.length) {
			const idx = i++;
			results[idx] = await fn(items[idx], idx);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

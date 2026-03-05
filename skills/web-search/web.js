#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { runSession } from "./session.js";
import {
	parseSearchArgs, formatResults,
	ENGINES, DEFAULT_ENGINE_ORDER,
} from "./search.js";
import {
	extractReadable, isBrowserErrorUrl,
	isBrowserErrorContent, formatJsonContent,
	isExtractableContentType,
} from "./content.js";
import { SearchError, formatError } from "./errors.js";
import {
	headContentType, downloadToTemp, formatDownloadResult,
} from "./download.js";

const BASE_DIR = import.meta.dirname;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const [cmd, ...argv] = process.argv.slice(2);

try {
	if (cmd === "verify") await verify();
	else if (cmd === "search") await search(argv);
	else if (cmd === "content") await contentCmd(argv);
	else usage(cmd);
} catch (e) {
	console.error(formatError(e, BASE_DIR));
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function verify() {
	const config = loadConfig();
	console.error("Config loaded successfully.");

	const title = await runSession(config, (session) => {
		session.goto("https://example.com");
		return session.eval("() => document.title");
	});

	if (title !== "Example Domain") {
		throw new Error(`Unexpected page title: "${title}" (expected "Example Domain")`);
	}

	console.log("Setup verified — browser connection, navigation, and content extraction all work.");
}

async function search(argv) {
	const { query, count, withContent, engine } = parseSearchArgs(argv);
	if (!query) {
		console.error("Usage: web.js search <query> [-n <num>] [--content] [--engine google|bing|ddg|brave]");
		process.exit(1);
	}

	const config = loadConfig();

	const { items, engine: usedEngine } = await runSession(config, (session) => {
		const result = searchWithFallback(session, query, count, engine);

		// Extract content from each result URL (sequential, same session)
		if (withContent && result.items.length) {
			for (const item of result.items) {
				try {
					item.content = extractContent(session, item.link);
				} catch (err) {
					item.content = `(Error: ${err.message})`;
				}
			}
		}

		return result;
	}, { leaveOpen: (err) => err instanceof SearchError });

	if (!items.length) {
		console.error("No results found.");
		process.exit(0);
	}

	console.log(formatResults(items, { query, engine: usedEngine }));
}

/**
 * Try engines in priority order until one returns results.
 *
 * When `engine` is specified (via --engine flag), only that engine is used.
 * Otherwise, tries each engine in DEFAULT_ENGINE_ORDER.
 *
 * SearchErrors (captcha/blocking) trigger fallback to the next engine.
 * If all engines fail, the last SearchError is re-thrown so runSession
 * can leave the session open for LLM intervention.
 *
 * @returns {{ items: Array, engine: string }} Results and the engine that produced them
 */
function searchWithFallback(session, query, count, engine) {
	const order = engine ? [engine] : DEFAULT_ENGINE_ORDER;
	let lastError = null;

	for (const engineId of order) {
		let items;
		let currentError = null;
		try {
			items = searchWithEngine(session, query, count, engineId);
		} catch (err) {
			if (!(err instanceof SearchError)) throw err;
			lastError = err;
			currentError = err;
			items = [];
		}

		if (items.length) {
			return { items, engine: engineId };
		}

		// Log and continue to next engine
		const nextIdx = order.indexOf(engineId) + 1;
		if (nextIdx < order.length) {
			const label = currentError ? currentError.message : "No results";
			const nextName = ENGINES[order[nextIdx]]?.name || order[nextIdx];
			console.error(`${label} — trying ${nextName}...`);
		}
	}

	// All engines failed with a search error — re-throw for LLM handoff
	if (lastError) {
		lastError.alternatives = order.filter(e => e !== lastError.engine);
		throw lastError;
	}

	return { items: [], engine: order[order.length - 1] };
}

/**
 * Search with a specific engine and return extracted results.
 *
 * Uses the ENGINES registry for URL building, DOM extraction, and
 * blocking detection. Throws SearchError on captcha/blocking so the
 * caller can attempt fallback or propagate for LLM handoff.
 */
function searchWithEngine(session, query, count, engineId) {
	const engine = ENGINES[engineId];
	if (!engine) throw new Error(`Unknown search engine: ${engineId}`);

	session.goto(engine.searchUrl(query));

	const blocking = engine.detectBlocking(session);
	if (blocking) {
		throw new SearchError(
			blocking.message,
			{ category: blocking.category, engine: engineId, query },
		);
	}

	return session.eval(engine.extractExpr(count)) || [];
}

async function contentCmd(argv) {
	const url = argv[0];
	if (!url) {
		console.error("Usage: web.js content <url>");
		process.exit(1);
	}

	requireHttpUrl(url);

	// HEAD check — binary content is downloaded via curl, no browser needed
	const head = headContentType(url);
	if (!isExtractableContentType(head.contentType)) {
		const dl = downloadToTemp(url, head);
		console.log(formatDownloadResult(dl));
		return;
	}

	const config = loadConfig();

	const result = await runSession(config, (session) => {
		return extractPageContent(session, url);
	});

	if (!result) {
		console.error("Could not extract readable content.");
		process.exit(1);
	}

	if (result.title) console.log(`# ${result.title}\n`);
	console.log(result.markdown);
}

// ---------------------------------------------------------------------------
// Content extraction — HEAD check routes to browser or curl download
// ---------------------------------------------------------------------------

/** Reject non-HTTP URL schemes with an actionable error. */
function requireHttpUrl(url) {
	if (!url.startsWith("http://") && !url.startsWith("https://")) {
		throw new Error(`Unsupported URL scheme: ${url} (only http:// and https:// are supported)`);
	}
}

/**
 * Extract content from a URL, choosing browser or curl download.
 *
 * Does a HEAD request first: if the content-type is binary, downloads
 * via curl (no browser needed). Otherwise extracts via the browser session.
 * Returns a markdown string.
 */
function extractContent(session, url) {
	requireHttpUrl(url);

	const head = headContentType(url);
	if (!isExtractableContentType(head.contentType)) {
		const dl = downloadToTemp(url, head);
		return formatDownloadResult(dl);
	}

	const result = extractPageContent(session, url);
	return result?.markdown || "(Could not extract content)";
}

/**
 * Navigate to a URL in the browser session and extract content as markdown.
 *
 * Handles navigation errors (PDFs, downloads), content-type detection
 * (JSON, plain text, images, HTML), and browser error pages.
 * Returns { title, markdown } or null if extraction fails.
 */
function extractPageContent(session, url) {
	try {
		session.goto(url);
	} catch (err) {
		// Navigation can fail for PDFs (browser PDF viewer disconnects the
		// extension), downloads, or other non-page content.
		// Strip raw execFileSync noise — only keep the first meaningful line.
		const msg = err.stderr?.split("\n")[0]?.trim() || err.message.split("\n")[0];
		throw new Error(`Navigation failed for ${url} (${msg})`);
	}

	const pageUrl = session.pageUrl();
	if (isBrowserErrorUrl(pageUrl)) {
		const bodyText = session.eval("() => document.body?.innerText?.substring(0, 300)");
		throw new Error(`Browser error page: ${bodyText || pageUrl}`);
	}

	const contentType = session.eval("() => document.contentType") || "text/html";

	// Reject non-extractable content types (images, video, binary)
	if (!isExtractableContentType(contentType)) {
		throw new Error(`Cannot extract content from ${contentType} (${url})`);
	}

	if (contentType.includes("application/json")) {
		const text = session.eval("() => document.body?.innerText");
		return text ? { title: null, markdown: formatJsonContent(text) } : null;
	}

	if (contentType.includes("text/plain")) {
		const text = session.eval("() => document.body?.innerText");
		return text ? { title: null, markdown: text } : null;
	}

	// HTML content — extract via Readability
	const html = session.eval("() => document.documentElement.outerHTML");
	if (!html) return null;

	if (isBrowserErrorContent(html)) {
		const bodyText = session.eval("() => document.body?.innerText?.substring(0, 300)");
		throw new Error(`Browser error page: ${bodyText || "unknown error"}`);
	}

	return extractReadable(html, url);
}

function usage(cmd) {
	console.error(
		`Usage: web.js <command> [options]

Commands:
  verify                                    Verify browser setup
  search <query> [-n <num>] [--content]     Search the web
  content <url>                             Extract page content as markdown

Options:
  -n <num>      Number of results (default: 10, max: 20)
  --content     Fetch and include page content from result URLs
  --engine      Search engine: google, bing, ddg, or brave

Default search tries: Google → DuckDuckGo → Brave → Bing (with fallback).
Use --engine to target a specific engine (no fallback).

Examples:
  web.js verify
  web.js search "python asyncio best practices"
  web.js search "rust error handling" -n 10 --content
  web.js search "test query" --engine ddg
  web.js content https://docs.example.com/guide`,
	);
	process.exit(cmd ? 1 : 0);
}

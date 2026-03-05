/**
 * Search engine definitions and result extraction.
 *
 * Each engine provides: URL builder, DOM extraction expression, blocking
 * detection, and display name. Extraction expressions are JavaScript strings
 * evaluated in the remote browser via session.eval().
 */

/** URL for Brave Search. */
export function braveSearchUrl(query) {
	return `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
}

/** URL for DuckDuckGo HTML version. */
export function ddgSearchUrl(query) {
	return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

/** URL for Google Search. */
export function googleSearchUrl(query) {
	return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/** URL for Bing Search. */
export function bingSearchUrl(query) {
	return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * JavaScript expression to extract search results from Brave Search DOM.
 * Returns an arrow function string suitable for session.eval().
 */
export function braveExtractExpr(max) {
	return `() => {
		const results = [];
		for (const el of document.querySelectorAll('[data-type="web"]')) {
			if (results.length >= ${max}) break;
			const a = el.querySelector('a[href]');
			if (!a) continue;
			const href = a.href || '';
			if (!href.startsWith('http') || href.includes('brave.com')) continue;
			const title = el.querySelector('.title')?.textContent?.trim() || '';
			if (!title) continue;
			const snippet = el.querySelector('.generic-snippet .content')?.textContent?.trim() ||
				el.querySelector('.snippet-description')?.textContent?.trim() || '';
			results.push({ title, link: href, snippet });
		}
		return results;
	}`;
}

/**
 * JavaScript expression to extract search results from DuckDuckGo DOM.
 */
export function ddgExtractExpr(max) {
	return `() => {
		const results = [];
		for (const el of document.querySelectorAll('.result')) {
			if (results.length >= ${max}) break;
			const a = el.querySelector('.result__a');
			if (!a) continue;
			let link = a.getAttribute('href') || '';
			if (link.includes('uddg=')) {
				try {
					const url = new URL(link, 'https://duckduckgo.com');
					link = decodeURIComponent(url.searchParams.get('uddg') || link);
				} catch {}
			}
			if (!link.startsWith('http') || link.includes('duckduckgo.com/y.js')) continue;
			const title = a.textContent?.trim() || '';
			if (!title) continue;
			const snippet = el.querySelector('.result__snippet')?.textContent?.trim() || '';
			results.push({ title, link, snippet });
		}
		return results;
	}`;
}

/**
 * JavaScript expression to extract search results from Google DOM.
 */
export function googleExtractExpr(max) {
	return `() => {
		const results = [];
		const seen = new Set();
		for (const el of document.querySelectorAll('div.tF2Cxc')) {
			if (results.length >= ${max}) break;
			const a = el.querySelector('a[jsname="UWckNb"]') || el.querySelector('div.yuRUbf a[href]');
			if (!a) continue;
			const href = a.href || '';
			if (!href.startsWith('http') || href.includes('google.com')) continue;
			if (seen.has(href)) continue;
			seen.add(href);
			const title = el.querySelector('h3')?.textContent?.trim() || '';
			if (!title) continue;
			const snippet = el.querySelector('div.VwiC3b')?.textContent?.trim() || '';
			results.push({ title, link: href, snippet });
		}
		return results;
	}`;
}

/**
 * JavaScript expression to extract search results from Bing DOM.
 * Decodes Bing's base64 tracking redirect URLs.
 */
export function bingExtractExpr(max) {
	return `() => {
		const results = [];
		for (const el of document.querySelectorAll('li.b_algo')) {
			if (results.length >= ${max}) break;
			const a = el.querySelector('h2 a[href]');
			if (!a) continue;
			let link = a.href || '';
			if (link.includes('bing.com/ck/a')) {
				try {
					const u = new URL(link);
					const encoded = u.searchParams.get('u');
					if (encoded && encoded.startsWith('a1')) {
						link = atob(encoded.substring(2));
					}
				} catch {}
			}
			if (!link.startsWith('http') || link.includes('bing.com')) continue;
			const title = a.textContent?.trim() || '';
			if (!title) continue;
			const snippet = el.querySelector('p.b_lineclamp2')?.textContent?.trim() ||
				el.querySelector('.b_caption p')?.textContent?.trim() || '';
			results.push({ title, link, snippet });
		}
		return results;
	}`;
}

/** Check page title for captcha/blocking signals. */
export function isCaptchaTitle(title) {
	if (!title) return false;
	const lower = title.toLowerCase();
	return lower.includes("captcha") || lower.includes("robot") || lower.includes("blocked");
}

/** Check DDG page body for bot detection signals. */
export function isDdgBlocked(bodyText) {
	if (!bodyText) return false;
	return bodyText.includes("not a robot") ||
		bodyText.includes("anomaly-modal") ||
		bodyText.includes("bots use DuckDuckGo");
}

/** Check Google page body for blocking signals. */
export function isGoogleBlocked(bodyText) {
	if (!bodyText) return false;
	return bodyText.includes("unusual traffic") ||
		bodyText.includes("not a robot");
}

/** Check Bing page content for blocking signals. */
export function isBingBlocked(content) {
	if (!content) return false;
	return content.includes("b_captcha") ||
		content.includes("unusual traffic");
}

// ---------------------------------------------------------------------------
// Engine registry
// ---------------------------------------------------------------------------

/** Default engine priority order for fallback chain. */
export const DEFAULT_ENGINE_ORDER = ["google", "ddg", "brave", "bing"];

/**
 * Engine registry — uniform interface for all search engines.
 *
 * Each entry provides:
 * - name: Human-readable display name
 * - searchUrl(query): URL for the search results page
 * - extractExpr(max): Browser JS expression to extract results from DOM
 * - detectBlocking(session): Returns { category, message } if blocked, null otherwise
 */
export const ENGINES = {
	google: {
		name: "Google",
		searchUrl: googleSearchUrl,
		extractExpr: googleExtractExpr,
		detectBlocking(session) {
			const bodyText = session.eval("() => document.body?.textContent?.substring(0, 1000)");
			if (isGoogleBlocked(bodyText)) {
				return { category: "captcha", message: "Google detected unusual traffic and is requesting verification" };
			}
			return null;
		},
	},
	bing: {
		name: "Bing",
		searchUrl: bingSearchUrl,
		extractExpr: bingExtractExpr,
		detectBlocking(session) {
			const content = session.eval("() => document.body?.innerHTML?.substring(0, 2000)");
			if (isBingBlocked(content)) {
				return { category: "captcha", message: "Bing detected unusual traffic and is requesting verification" };
			}
			return null;
		},
	},
	ddg: {
		name: "DuckDuckGo",
		searchUrl: ddgSearchUrl,
		extractExpr: ddgExtractExpr,
		detectBlocking(session) {
			const bodyText = session.eval("() => document.body?.textContent?.substring(0, 500)");
			if (isDdgBlocked(bodyText)) {
				return { category: "blocked", message: "DuckDuckGo blocked the request (bot detection)" };
			}
			return null;
		},
	},
	brave: {
		name: "Brave Search",
		searchUrl: braveSearchUrl,
		extractExpr: braveExtractExpr,
		detectBlocking(session) {
			const title = session.pageTitle();
			if (isCaptchaTitle(title)) {
				return { category: "captcha", message: `Brave Search showed a captcha (page title: "${title}")` };
			}
			return null;
		},
	},
};

/**
 * Format search results as a markdown document.
 *
 * @param {Array<{title: string, link: string, snippet: string, content?: string}>} results
 * @param {object} options
 * @param {string} options.query - The original search query
 * @param {string} options.engine - Engine ID that produced these results
 * @returns {string} Markdown document
 */
export function formatResults(results, { query, engine }) {
	const engineName = ENGINES[engine]?.name || engine;
	const lines = [];

	lines.push(`# Search: "${query}"`);
	lines.push("");
	lines.push(`Found ${results.length} result${results.length !== 1 ? "s" : ""} via ${engineName}.`);

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push("");
		lines.push(`## ${i + 1}. ${r.title}`);
		lines.push("");
		lines.push(`**URL:** ${r.link}`);
		lines.push("");
		lines.push(r.snippet);
		if (r.content) {
			lines.push("");
			lines.push(r.content);
		}
	}

	return lines.join("\n");
}

/**
 * Parse search command arguments.
 */
export function parseSearchArgs(argv) {
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

	let engine = null;
	const ei = args.indexOf("--engine");
	if (ei !== -1) {
		const value = args[ei + 1];
		if (ENGINES[value]) {
			engine = value;
		} else if (value) {
			const valid = Object.keys(ENGINES).join(", ");
			console.error(`Unknown engine "${value}" — valid engines: ${valid}. Using default.`);
		}
		args.splice(ei, 2);
	}

	const query = args.join(" ").trim();
	return { query, count, withContent, engine };
}

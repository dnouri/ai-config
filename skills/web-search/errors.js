/**
 * Error types and formatting for LLM-friendly error output.
 */

/**
 * Error thrown when another web-search process owns the browser profile lock.
 */
export class WebSearchBusyError extends Error {
	constructor({
		profileHash,
		ownerPid,
		ownerOperation,
		ownerStartedAt,
		requestedOperation,
		metadataReadable = true,
		lockDirExists = true,
	} = {}) {
		const lines = [
			"Another web-search operation is already using this browser profile.",
			"",
			"Retry this command after about 60 seconds. Do not start multiple browser-backed `web.js` commands in parallel.",
		];

		if (profileHash) lines.push("", `**Profile:** \`${profileHash}\``);
		if (ownerPid) lines.push(`**Owner PID:** \`${ownerPid}\``);
		if (ownerOperation) lines.push(`**Owner operation:** \`${ownerOperation}\``);
		if (ownerStartedAt) lines.push(`**Started:** \`${ownerStartedAt}\``);
		if (requestedOperation) lines.push(`**Requested operation:** \`${requestedOperation}\``);
		if (!metadataReadable && lockDirExists) {
			lines.push("", "The lock metadata is not readable yet. Retry after about 60 seconds.");
		}

		super(lines.join("\n"));
		this.name = "WebSearchBusyError";
		this.code = "WEB_SEARCH_BUSY";
		this.profileHash = profileHash;
		this.ownerPid = ownerPid;
		this.ownerOperation = ownerOperation;
		this.ownerStartedAt = ownerStartedAt;
		this.requestedOperation = requestedOperation;
	}
}

/**
 * Error thrown when a search engine blocks or shows a captcha.
 */
export class SearchError extends Error {
	/**
	 * @param {string} message - Human-readable description
	 * @param {object} options
	 * @param {string} options.category - "captcha" | "blocked"
	 * @param {string} [options.engine] - "google" | "bing" | "ddg" | "brave"
	 * @param {string} [options.query] - Original search query
	 */
	constructor(message, { category, engine, query } = {}) {
		super(message);
		this.name = "SearchError";
		this.category = category;
		this.engine = engine;
		this.query = query;
	}
}

/**
 * Format an error into an actionable markdown document for the LLM.
 *
 * If the error has a `sessionName` property (set by runSession when
 * leaveOpen is true), includes the session name and playwright-cli
 * commands for the LLM to investigate and resolve the issue.
 *
 * @param {Error} err - The error to format
 * @param {string} [baseDir] - Skill directory for retry commands
 * @returns {string} Markdown-formatted error with resolution steps
 */
export function formatError(err, baseDir) {
	const lines = [];

	// Heading based on error type
	if (err instanceof SearchError && err.category) {
		const label = err.category === "captcha" ? "Captcha" : "Blocked";
		lines.push(`# Search Error: ${label}`);
	} else if (err instanceof WebSearchBusyError || err.code === "WEB_SEARCH_BUSY") {
		lines.push("# Web Search Busy");
	} else {
		lines.push("# Error");
	}

	lines.push("");
	lines.push(err.message);

	if (err.sessionName) {
		const dir = baseDir || ".";
		const s = err.sessionName;

		lines.push("");
		lines.push(`**Session \`${s}\` is still open** with the page loaded.`);
		lines.push("");
		lines.push("## How to resolve");
		lines.push("");
		lines.push(`1. View the page: \`playwright-cli -s ${s} snapshot\``);
		lines.push("2. Interact with the page to resolve the issue");
		lines.push(`3. Close the session: \`playwright-cli -s ${s} close\``);

		if (err.query) {
			lines.push(`4. Retry: \`${dir}/web.js search "${err.query}"\``);
		}

		if (err.alternatives?.length) {
			const altList = err.alternatives.map(e => `\`--engine ${e}\``).join(", ");
			lines.push("");
			lines.push(`Or try a different engine: ${altList}`);
		}
	}

	return lines.join("\n");
}

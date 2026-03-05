/**
 * Error types and formatting for LLM-friendly error output.
 */

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

import { execFileSync } from "child_process";

let sessionCounter = 0;

/**
 * Generate a unique session name for playwright-cli.
 */
export function sessionName() {
	return `web-search-${process.pid}-${sessionCounter++}`;
}

/**
 * Build the environment variables for playwright-cli subprocess calls.
 *
 * Sets the extension token and overrides paths via env vars. This is
 * critical because the config file may contain ~ in paths, which
 * playwright-cli does not expand. Env vars with expanded paths take
 * precedence over config file values.
 */
export function buildSessionEnv(config) {
	const env = {
		...process.env,
		PLAYWRIGHT_MCP_EXTENSION_TOKEN: config.extensionToken,
	};

	if (config.browser?.launchOptions?.executablePath) {
		env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = config.browser.launchOptions.executablePath;
	}
	if (config.browser?.userDataDir) {
		env.PLAYWRIGHT_MCP_USER_DATA_DIR = config.browser.userDataDir;
	}

	return env;
}

/**
 * Parse a result value from playwright-cli output.
 *
 * playwright-cli outputs results in a markdown format:
 *   ### Result
 *   "some value"
 *   ### Ran Playwright code
 *
 * Results may be single-line or pretty-printed multi-line JSON.
 * This collects all lines between "### Result" and the next "###"
 * heading, then JSON-parses the combined text.
 */
export function parsePlaywrightResult(output) {
	const lines = output.split("\n");
	let inResult = false;
	const resultLines = [];

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed === "### Result") {
			inResult = true;
			continue;
		}

		if (inResult) {
			// Stop at next markdown heading
			if (trimmed.startsWith("### ")) break;
			resultLines.push(line);
		}
	}

	const text = resultLines.join("\n").trim();
	if (!text) return null;

	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Create a user-friendly error message for browser connection failures.
 *
 * @param {Error} err - The raw execFileSync error from playwright-cli open
 * @returns {Error} A new Error with a clear diagnostic message
 */
export function connectionError(err) {
	const stderr = err.stderr?.trim() || "";
	const hint = stderr.includes("timeout")
		? "The browser may already be running — close it and retry."
		: "Check that the browser and Playwright MCP Bridge extension are installed.";
	return new Error(
		`Could not connect to the automation browser.\n${hint}\n` +
		`Run \`web.js verify\` to diagnose, or see references/setup-browser.md.`,
	);
}

/**
 * Run a callback with a managed playwright-cli session.
 *
 * Opens a browser session via --extension, runs the callback with a session
 * object providing goto/eval/snapshot methods, then closes the session.
 *
 * @param {object} config - Loaded config from loadConfig()
 * @param {function} callback - async (session) => result
 * @param {object} [options]
 * @param {boolean|function} [options.leaveOpen] - Leave session open on error
 *   for LLM handoff. If a function, called with the error; session is left
 *   open only if the function returns true.
 * @returns {Promise<*>} The callback's return value
 */
export async function runSession(config, callback, options = {}) {
	const name = sessionName();
	const env = buildSessionEnv(config);

	const cli = (args, opts = {}) => {
		return execFileSync("playwright-cli", ["-s", name, ...args], {
			encoding: "utf-8",
			env,
			maxBuffer: 10 * 1024 * 1024,
			timeout: opts.timeout ?? 30_000,
			...opts,
		});
	};

	// Open the browser with extension mode
	const openArgs = ["open", "--extension", `--config=${config.configPath}`];
	try {
		cli(openArgs, { timeout: 15_000 });
	} catch (err) {
		throw connectionError(err);
	}

	let shouldClose = true;
	try {
		const session = {
			name,

			goto(url) {
				cli(["goto", url], { timeout: 60_000 });
			},

			eval(expr) {
				const output = cli(["eval", expr]);
				return parsePlaywrightResult(output);
			},

			snapshot() {
				return cli(["snapshot"]);
			},

			tabNew(url) {
				cli(["tab-new", url], { timeout: 60_000 });
			},

			tabSelect(index) {
				cli(["tab-select", String(index)]);
			},

			tabList() {
				return cli(["tab-list"]);
			},

			pageTitle() {
				return this.eval("() => document.title");
			},

			pageUrl() {
				return this.eval("() => window.location.href");
			},
		};

		return await callback(session);
	} catch (err) {
		const leave = typeof options.leaveOpen === "function"
			? options.leaveOpen(err)
			: options.leaveOpen;
		if (leave) {
			shouldClose = false;
			err.sessionName = name;
		}
		throw err;
	} finally {
		if (shouldClose) {
			try {
				cli(["close"], { timeout: 5_000 });
			} catch {
				// Best-effort cleanup
			}
		}
	}
}

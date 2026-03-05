import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Default config file location (XDG-style). */
export const CONFIG_PATH = join(homedir(), ".config", "web-search", "config.json");

const SETUP_GUIDE = "references/setup-browser.md";

/**
 * Expand leading ~ to the user's home directory.
 */
export function expandTilde(p) {
	if (p.startsWith("~/")) {
		return join(homedir(), p.slice(2));
	}
	return p;
}

/**
 * Load and validate the web-search config file.
 *
 * @param {string} [configPath] - Path to config file. Defaults to CONFIG_PATH.
 * @returns {{ extensionToken: string, browser: object, configPath: string }}
 * @throws {Error} with actionable message pointing to setup guide.
 */
export function loadConfig(configPath = CONFIG_PATH) {
	let raw;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (err) {
		if (err.code === "ENOENT") {
			throw new Error(
				`Config file not found at ${configPath}\n` +
				`Run through the setup guide at ${SETUP_GUIDE} to configure the browser.`,
			);
		}
		throw err;
	}

	let config;
	try {
		config = JSON.parse(raw);
	} catch {
		throw new Error(
			`Could not parse config file at ${configPath} — invalid JSON.\n` +
			`Check the file format in ${SETUP_GUIDE}.`,
		);
	}

	// Validate required fields
	if (!config.extensionToken || typeof config.extensionToken !== "string") {
		throw new Error(
			`Missing "extensionToken" in ${configPath}.\n` +
			`Get it from the Playwright MCP Bridge extension — see ${SETUP_GUIDE}.`,
		);
	}

	if (!config.browser || typeof config.browser !== "object") {
		throw new Error(
			`Missing "browser" section in ${configPath}.\n` +
			`See ${SETUP_GUIDE} for the expected format.`,
		);
	}

	if (!config.browser.userDataDir || typeof config.browser.userDataDir !== "string") {
		throw new Error(
			`Missing "browser.userDataDir" in ${configPath}.\n` +
			`A dedicated automation profile is required — see ${SETUP_GUIDE}.`,
		);
	}

	const executablePath = config.browser.launchOptions?.executablePath;
	if (!executablePath || typeof executablePath !== "string") {
		throw new Error(
			`Missing "browser.launchOptions.executablePath" in ${configPath}.\n` +
			`Set it to the path of your browser executable — see ${SETUP_GUIDE}.`,
		);
	}

	// Expand ~ in paths
	config.browser.userDataDir = expandTilde(config.browser.userDataDir);
	config.browser.launchOptions.executablePath = expandTilde(executablePath);

	// Env var overrides config token (useful for testing)
	if (process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) {
		config.extensionToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
	}

	config.configPath = configPath;
	return config;
}

import { execFileSync } from "child_process";
import { writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync, unlinkSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir, platform } from "os";
import { acquireProfileLock } from "./lock.js";

let sessionCounter = 0;

const BROWSER_DIR_PREFIX = "web-search-browser-";

/**
 * Return the PID file path for the browser managed by this web.js process.
 */
export function browserPidFile(config) {
	if (!config.browser?.launchOptions?.executablePath) return null;
	return join(tmpdir(), `${BROWSER_DIR_PREFIX}${process.pid}`, "browser.pid");
}

/**
 * Create the executable that playwright-cli launches in extension mode.
 *
 * Current playwright-cli attach sessions neither honor browser.userDataDir
 * for custom executables nor stop the external browser when detached. The
 * wrapper supplies the dedicated profile, applies optional headless mode,
 * and records the browser PID so web-search can own its lifecycle safely.
 */
function browserWrapper(config, pidFile) {
	const dir = join(tmpdir(), `${BROWSER_DIR_PREFIX}${process.pid}`);
	mkdirSync(dir, { recursive: true });
	const wrapperPath = join(dir, "browser-launcher");
	const executablePath = config.browser.launchOptions.executablePath;
	const launchArgs = [];
	if (config.browser.userDataDir) launchArgs.push(`--user-data-dir=${config.browser.userDataDir}`);
	if (config.browser.launchOptions.headless === true) launchArgs.push("--headless=new");
	const command = [
		JSON.stringify(executablePath),
		...launchArgs.map(arg => JSON.stringify(arg)),
		'"$@"',
	].join(" ");
	writeFileSync(
		wrapperPath,
		`#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec ${command}\n`,
	);
	chmodSync(wrapperPath, 0o755);
	return wrapperPath;
}

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

	const pidFile = browserPidFile(config);
	if (pidFile) env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = browserWrapper(config, pidFile);
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
 * Resolve the playwright-cli daemon session directory.
 *
 * Must match the logic in playwright's own registry.js — it uses
 * platform-specific cache dirs, not a hardcoded ~/.cache path.
 */
function daemonBaseDir() {
	const p = platform();
	if (p === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright", "daemon");
	if (p === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ms-playwright", "daemon");
	return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright", "daemon");
}

/**
 * Check whether a process is still running.
 */
function isProcessAlive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Check whether a PID belongs to a browser process (brave/chromium/chrome).
 *
 * Used before killing a PID read from a stale PID file. If the original
 * browser died and the PID was recycled by an unrelated process, this
 * prevents us from killing an innocent bystander.
 *
 * Returns false when the process is dead or when we can't determine its
 * identity — the safe default is to not kill.
 */
function isBrowserProcess(pid) {
	// Try /proc (Linux — fast, no subprocess)
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
		return /brave|chrom/i.test(cmdline);
	} catch { /* /proc not available or process gone */ }

	// Fall back to ps (macOS, BSDs)
	try {
		const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf-8",
			timeout: 2_000,
		}).trim();
		return /brave|chrom/i.test(cmd);
	} catch { /* process gone or ps failed */ }

	return false;
}

/**
 * Reap resources orphaned by dead web-search processes.
 *
 * Each web.js invocation stores its browser PID file in a directory keyed
 * by its own process.pid: /tmp/web-search-browser-{pid}/. If that process
 * dies before cleanup (timeout, crash, SIGKILL), its browser and playwright
 * daemons are orphaned.
 *
 * This function scans for such orphans and cleans them up. It is safe for
 * concurrent sessions: resources owned by still-running processes are never
 * touched.
 */
export function reapStaleResources() {
	reapStaleBrowsers();
	reapStaleDaemonSessions();
}

/**
 * Kill browsers and remove tmp dirs left by dead web.js processes.
 */
function reapStaleBrowsers() {
	const prefixes = [BROWSER_DIR_PREFIX, "web-search-headless-"];
	const tmp = tmpdir();
	let entries;
	try { entries = readdirSync(tmp); } catch { return; }

	for (const entry of entries) {
		const prefix = prefixes.find(candidate => entry.startsWith(candidate));
		if (!prefix) continue;
		const ownerPid = parseInt(entry.slice(prefix.length), 10);
		if (!ownerPid || isNaN(ownerPid)) continue;
		if (ownerPid === process.pid) continue;
		if (isProcessAlive(ownerPid)) continue;

		// Owner is dead — reap its browser and directory
		const dir = join(tmp, entry);
		const pidFile = join(dir, "browser.pid");
		if (existsSync(pidFile)) {
			try {
				const browserPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
				if (browserPid && !isNaN(browserPid) && isBrowserProcess(browserPid)) {
					try { process.kill(-browserPid, "SIGTERM"); } catch { /* already gone */ }
					try { process.kill(browserPid, "SIGTERM"); } catch { /* already gone */ }
				}
			} catch { /* ignore read errors */ }
		}
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

/**
 * Remove stale playwright-cli daemon session files left by dead processes.
 *
 * Session files live under ~/.cache/ms-playwright/daemon/{hash}/ and are
 * named web-search-{pid}-{counter}.session. Stale daemons are terminated by
 * their unique session name before the abandoned file is removed.
 */
function reapStaleDaemonSessions() {
	const daemonBase = daemonBaseDir();
	let hashes;
	try { hashes = readdirSync(daemonBase); } catch { return; }

	for (const hash of hashes) {
		const hashDir = join(daemonBase, hash);
		let files;
		try { files = readdirSync(hashDir); } catch { continue; }

		for (const file of files) {
			const match = file.match(/^web-search-(\d+)-\d+\.session$/);
			if (!match) continue;
			const ownerPid = parseInt(match[1], 10);
			if (ownerPid === process.pid || isProcessAlive(ownerPid)) continue;

			killSessionDaemon(file.slice(0, -".session".length));
			try { unlinkSync(join(hashDir, file)); } catch { /* ignore */ }
		}
	}
}

/**
 * Create a user-friendly error message for browser connection failures.
 *
 * @param {Error} err - The raw execFileSync error from playwright-cli attach
 * @returns {Error} A new Error with a clear diagnostic message
 */
export function connectionError(err) {
	const details = `${err.stderr?.trim() || ""}\n${err.message || ""}`;
	const timedOut = err.code === "ETIMEDOUT" || /tim(?:e|ed)\s*out/i.test(details);
	const hint = timedOut
		? "The browser may already be running, or the extension token may be stale — close the automation browser and refresh the token in config.json."
		: "Check that the browser and Playwright extension are installed.";
	const error = new Error(
		`Could not connect to the automation browser.\n${hint}\n` +
		`Run \`web.js verify\` to diagnose, or see references/setup-browser.md.`,
	);
	error.code = "BROWSER_UNAVAILABLE";
	return error;
}

/**
 * Run a callback with a managed playwright-cli session.
 *
 * Attaches to the dedicated browser via the Playwright extension, runs the
 * callback, then detaches the CLI session and stops the managed browser.
 *
 * @param {object} config - Loaded config from loadConfig()
 * @param {function} callback - async (session) => result
 * @param {object} [options]
 * @param {boolean|function} [options.leaveOpen] - Leave session open on error
 *   for LLM handoff. If a function, called with the error; session is left
 *   open only if the function returns true.
 * @param {string} [options.operation] - Short operation label for lock metadata
 * @returns {Promise<*>} The callback's return value
 */
export async function runSession(config, callback, options = {}) {
	reapStaleResources();

	const lock = acquireProfileLock(config, { operation: options.operation });
	try {
		return await runUnlockedSession(config, callback, options);
	} finally {
		lock.release();
	}
}

async function runUnlockedSession(config, callback, options = {}) {
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

	// Current playwright-cli exposes extension sessions through `attach`.
	// A failed attach may leave its detached daemon and browser behind, so
	// both must be cleaned up before the connection error is propagated.
	const attachArgs = ["attach", "--extension=chrome", `--config=${config.configPath}`];
	try {
		cli(attachArgs, { timeout: 15_000 });
	} catch (err) {
		cleanupFailedAttach(cli, config, name);
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
				cli(["detach"], { timeout: 5_000 });
			} catch {
				// Best-effort cleanup
			}
			killManagedBrowser(config);
		}
	}
}

/**
 * Clean up after a failed `attach` command.
 *
 * The daemon may not have opened its command socket yet, so detach is tried
 * first and then the uniquely named daemon is terminated directly.
 */
function cleanupFailedAttach(cli, config, sessionName) {
	try { cli(["detach"], { timeout: 5_000 }); } catch { /* may not be reachable */ }
	killSessionDaemon(sessionName);
	killManagedBrowser(config);
}

/** Kill old and current playwright-cli daemon shapes for one unique session. */
function killSessionDaemon(sessionName) {
	const patterns = [
		`[/]cliDaemon\\.js ${sessionName}( |$)`,
		`daemon-session=.*${sessionName}\\.session`,
	];
	for (const pattern of patterns) {
		try {
			execFileSync("pkill", ["-f", pattern], {
				timeout: 3_000,
				stdio: "ignore",
			});
		} catch { /* no matching process, or already dead */ }
	}
}

/**
 * Stop the dedicated browser and remove its launcher directory.
 */
function killManagedBrowser(config) {
	const pidFile = browserPidFile(config);
	if (!pidFile) return;

	const dir = join(tmpdir(), `${BROWSER_DIR_PREFIX}${process.pid}`);

	if (existsSync(pidFile)) {
		try {
			const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			if (pid && !isNaN(pid) && isBrowserProcess(pid)) {
				try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
				try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
			}
		} catch { /* ignore read errors */ }
	}

	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

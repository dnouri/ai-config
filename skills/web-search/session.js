import { execFileSync } from "child_process";
import { writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync, unlinkSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir, platform } from "os";
import { acquireProfileLock } from "./lock.js";

let sessionCounter = 0;


/**
 * Return the PID file path for the headless browser, or null if not headless.
 */
export function headlessPidFile(config) {
	if (config.browser?.launchOptions?.headless !== true) return null;
	return join(tmpdir(), `web-search-headless-${process.pid}`, "browser.pid");
}

/**
 * Create a launcher script that starts the browser in headless mode.
 *
 * playwright-cli's extension mode spawns the browser binary directly,
 * bypassing Playwright's launch options. This wrapper injects --headless=new
 * so the browser runs without a visible window while still loading extensions
 * (supported in Chromium 112+).
 *
 * The wrapper also records the browser PID so runSession can kill it after
 * the session closes (cdpRelay spawns the browser detached, so playwright-cli's
 * close command only drops the WebSocket — it doesn't terminate the process).
 */
function headlessWrapper(executablePath, pidFile) {
	const dir = join(tmpdir(), `web-search-headless-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	const wrapperPath = join(dir, "browser-headless");
	writeFileSync(
		wrapperPath,
		`#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec ${JSON.stringify(executablePath)} --headless=new "$@"\n`,
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

	if (config.browser?.launchOptions?.executablePath) {
		const pidFile = headlessPidFile(config);
		env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = pidFile
			? headlessWrapper(config.browser.launchOptions.executablePath, pidFile)
			: config.browser.launchOptions.executablePath;
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
 * by its own process.pid: /tmp/web-search-headless-{pid}/. If that process
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
	const prefix = "web-search-headless-";
	const tmp = tmpdir();
	let entries;
	try { entries = readdirSync(tmp); } catch { return; }

	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
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
 * named web-search-{pid}-{counter}.session. Removing a stale session file
 * causes the daemon to exit on its next health check.
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

			try { unlinkSync(join(hashDir, file)); } catch { /* ignore */ }
		}
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
 * Opens a browser session via --extension, runs the callback with a session
 * object providing goto/eval/snapshot methods, then closes the session.
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

	// Open the browser with extension mode.
	// The open command starts a daemon before connecting to the browser.
	// If the browser connection fails (e.g. extension timeout), the daemon
	// may already be running — we must shut it down before propagating.
	const openArgs = ["open", "--extension", `--config=${config.configPath}`];
	try {
		cli(openArgs, { timeout: 15_000 });
	} catch (err) {
		cleanupFailedOpen(cli, config, name);
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
			killHeadlessBrowser(config);
		}
	}
}

/**
 * Clean up after a failed `open` command.
 *
 * When `open` fails (e.g. extension timeout), the daemon may be in one of
 * two states:
 * 1. Listening on its socket — `close` can reach and stop it.
 * 2. Not listening (createContext failed before server.listen) — `close`
 *    prints "not open" and the daemon stays alive. We must kill it directly.
 *
 * We try `close` first (clean path), then fall back to pkill on the
 * daemon's session file pattern (safe — the session name is unique).
 */
function cleanupFailedOpen(cli, config, sessionName) {
	// Try the clean path — works when the daemon opened its socket
	try { cli(["close"], { timeout: 5_000 }); } catch { /* may not be reachable */ }

	// Kill any daemon that's stuck without a socket (matched by session file)
	try {
		execFileSync("pkill", ["-f", `daemon-session=.*${sessionName}\\.session`], {
			timeout: 3_000,
			stdio: "ignore",
		});
	} catch { /* no matching process, or already dead */ }

	killHeadlessBrowser(config);
}

/**
 * Kill the headless browser process and clean up the tmp directory.
 * No-op when headless is not enabled or the PID file doesn't exist.
 */
function killHeadlessBrowser(config) {
	const pidFile = headlessPidFile(config);
	if (!pidFile) return;

	const dir = join(tmpdir(), `web-search-headless-${process.pid}`);

	if (existsSync(pidFile)) {
		try {
			const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			if (pid && !isNaN(pid)) {
				// Kill the process group (negative PID) to catch all child processes
				try { process.kill(-pid, "SIGTERM"); } catch { /* ignore — may already be gone */ }
				// Also kill the PID directly in case it wasn't a process group leader
				try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
			}
		} catch { /* ignore read errors */ }
	}

	// Remove the entire tmp directory (wrapper script + PID file)
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

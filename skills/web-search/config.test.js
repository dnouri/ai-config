import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, CONFIG_PATH, expandTilde } from "./config.js";

const TEST_DIR = join(tmpdir(), "web-search-config-test-" + process.pid);

function writeConfig(dir, obj) {
	const path = join(dir, "config.json");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(obj, null, 2));
	return path;
}

describe("expandTilde", () => {
	test("expands ~ at start of path", () => {
		const result = expandTilde("~/foo/bar");
		assert.equal(result, join(process.env.HOME, "foo/bar"));
	});

	test("leaves absolute paths unchanged", () => {
		assert.equal(expandTilde("/usr/bin/foo"), "/usr/bin/foo");
	});

	test("leaves paths without ~ unchanged", () => {
		assert.equal(expandTilde("relative/path"), "relative/path");
	});
});

describe("loadConfig", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("loads valid config with all required fields", () => {
		const configDir = join(TEST_DIR, "valid");
		const configPath = writeConfig(configDir, {
			extensionToken: "test-token-abc",
			browser: {
				browserName: "chromium",
				userDataDir: "/home/user/.config/web-search/browser-profile",
				launchOptions: {
					executablePath: "/usr/bin/chromium",
				},
			},
		});

		const config = loadConfig(configPath);

		assert.equal(config.extensionToken, "test-token-abc");
		assert.equal(config.browser.userDataDir, "/home/user/.config/web-search/browser-profile");
		assert.equal(config.browser.launchOptions.executablePath, "/usr/bin/chromium");
		assert.equal(config.configPath, configPath);
	});

	test("expands ~ in userDataDir", () => {
		const configDir = join(TEST_DIR, "tilde");
		const configPath = writeConfig(configDir, {
			extensionToken: "tok",
			browser: {
				userDataDir: "~/.config/web-search/browser-profile",
				launchOptions: { executablePath: "/usr/bin/chromium" },
			},
		});

		const config = loadConfig(configPath);
		assert.equal(
			config.browser.userDataDir,
			join(process.env.HOME, ".config/web-search/browser-profile"),
		);
	});

	test("expands ~ in executablePath", () => {
		const configDir = join(TEST_DIR, "tilde-exec");
		const configPath = writeConfig(configDir, {
			extensionToken: "tok",
			browser: {
				userDataDir: "/tmp/profile",
				launchOptions: { executablePath: "~/bin/brave" },
			},
		});

		const config = loadConfig(configPath);
		assert.equal(
			config.browser.launchOptions.executablePath,
			join(process.env.HOME, "bin/brave"),
		);
	});

	test("throws with setup instructions when config file is missing", () => {
		const missingPath = join(TEST_DIR, "nonexistent", "config.json");

		assert.throws(
			() => loadConfig(missingPath),
			(err) => {
				assert.match(err.message, /config.*not found/i);
				assert.match(err.message, /setup-browser\.md/);
				return true;
			},
		);
	});

	test("throws when extensionToken is missing", () => {
		const configDir = join(TEST_DIR, "no-token");
		const configPath = writeConfig(configDir, {
			browser: {
				userDataDir: "/tmp/profile",
				launchOptions: { executablePath: "/usr/bin/chromium" },
			},
		});

		assert.throws(
			() => loadConfig(configPath),
			(err) => {
				assert.match(err.message, /extensionToken/);
				return true;
			},
		);
	});

	test("throws when executablePath is missing", () => {
		const configDir = join(TEST_DIR, "no-exec");
		const configPath = writeConfig(configDir, {
			extensionToken: "tok",
			browser: {
				userDataDir: "/tmp/profile",
				launchOptions: {},
			},
		});

		assert.throws(
			() => loadConfig(configPath),
			(err) => {
				assert.match(err.message, /executablePath/);
				return true;
			},
		);
	});

	test("throws when browser section is missing", () => {
		const configDir = join(TEST_DIR, "no-browser");
		const configPath = writeConfig(configDir, {
			extensionToken: "tok",
		});

		assert.throws(
			() => loadConfig(configPath),
			(err) => {
				assert.match(err.message, /browser/i);
				return true;
			},
		);
	});

	test("throws when JSON is malformed", () => {
		const configDir = join(TEST_DIR, "bad-json");
		const configPath = join(configDir, "config.json");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(configPath, "not json {{{");

		assert.throws(
			() => loadConfig(configPath),
			(err) => {
				assert.match(err.message, /parse|invalid/i);
				return true;
			},
		);
	});

	test("uses default config path when none specified", () => {
		// loadConfig() with no args should use CONFIG_PATH
		// We can't easily test this without the file existing,
		// but we verify the default path is sensible
		assert.match(CONFIG_PATH, /\.config\/web-search\/config\.json$/);
	});

	test("allows PLAYWRIGHT_MCP_EXTENSION_TOKEN env to override token", () => {
		const configDir = join(TEST_DIR, "env-override");
		const configPath = writeConfig(configDir, {
			extensionToken: "config-token",
			browser: {
				userDataDir: "/tmp/profile",
				launchOptions: { executablePath: "/usr/bin/chromium" },
			},
		});

		const original = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
		try {
			process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = "env-token";
			const config = loadConfig(configPath);
			assert.equal(config.extensionToken, "env-token");
		} finally {
			if (original !== undefined) {
				process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = original;
			} else {
				delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
			}
		}
	});

	test("throws when userDataDir is missing", () => {
		const configDir = join(TEST_DIR, "no-datadir");
		const configPath = writeConfig(configDir, {
			extensionToken: "tok",
			browser: {
				launchOptions: { executablePath: "/usr/bin/chromium" },
			},
		});

		assert.throws(
			() => loadConfig(configPath),
			(err) => {
				assert.match(err.message, /userDataDir/);
				assert.match(err.message, /setup-browser\.md/);
				return true;
			},
		);
	});

	test("preserves extra config fields for playwright-cli compatibility", () => {
		const configDir = join(TEST_DIR, "extra");
		const configPath = writeConfig(configDir, {
			extensionToken: "tok",
			browser: {
				browserName: "chromium",
				userDataDir: "/tmp/profile",
				launchOptions: { executablePath: "/usr/bin/chromium" },
				contextOptions: { viewport: null },
			},
			snapshot: { mode: "incremental" },
		});

		const config = loadConfig(configPath);
		assert.equal(config.browser.contextOptions.viewport, null);
		assert.equal(config.snapshot.mode, "incremental");
	});
});

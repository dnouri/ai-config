import { describe, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
	acquireProfileLock,
	defaultLockBaseDir,
	normalizeProfilePath,
	profileHashForConfig,
} from "./lock.js";

const roots = [];

function tmpRoot(name) {
	const dir = join(tmpdir(), `web-search-lock-test-${process.pid}-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	roots.push(dir);
	return dir;
}

function config(userDataDir) {
	return {
		extensionToken: "secret-token-that-must-not-be-written",
		configPath: "/secret/config.json",
		browser: {
			userDataDir,
			launchOptions: { executablePath: "/secret/browser" },
		},
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("defaultLockBaseDir", () => {
	test("uses XDG_RUNTIME_DIR when present", () => {
		assert.equal(
			defaultLockBaseDir({ XDG_RUNTIME_DIR: "/run/user/1000" }),
			"/run/user/1000/web-search/locks",
		);
	});

	test("falls back to a uid-scoped tmp directory", () => {
		assert.match(defaultLockBaseDir({}), /web-search-locks-/);
	});
});

describe("profile identity", () => {
	test("normalizes profile paths before hashing", () => {
		const dir = tmpRoot("profile");
		mkdirSync(dir, { recursive: true });

		const a = profileHashForConfig(config(join(dir, ".")));
		const b = profileHashForConfig(config(dir));

		assert.equal(a, b);
		assert.equal(a.length, 32);
	});

	test("normalizeProfilePath does not require the path to exist", () => {
		const root = tmpRoot("missing");
		const missing = join(root, "does-not-exist", "..");
		assert.equal(normalizeProfilePath(missing), root);
	});
});

describe("acquireProfileLock", () => {
	test("creates private lock directories and secret-free metadata", () => {
		const base = tmpRoot("locks");
		const profile = tmpRoot("profile");
		mkdirSync(profile, { recursive: true });

		const lock = acquireProfileLock(config(profile), { operation: "search", lockBaseDir: base });
		try {
			assert.equal(statSync(base).mode & 0o777, 0o700);
			assert.equal(statSync(lock.path).mode & 0o777, 0o700);

			const metadata = JSON.parse(readFileSync(join(lock.path, "metadata.json"), "utf-8"));
			assert.deepEqual(Object.keys(metadata).sort(), ["operation", "pid", "profileHash", "startedAt"]);
			assert.equal(metadata.pid, process.pid);
			assert.equal(metadata.operation, "search");
			assert.equal(metadata.profileHash, lock.profileHash);

			const raw = JSON.stringify(metadata);
			assert.ok(!raw.includes("secret-token"));
			assert.ok(!raw.includes(profile));
			assert.ok(!raw.includes("/secret"));
		} finally {
			lock.release();
		}
	});

	test("throws a markdown busy error when another live process owns the profile", () => {
		const base = tmpRoot("busy");
		const profile = tmpRoot("profile");
		mkdirSync(profile, { recursive: true });
		const first = acquireProfileLock(config(profile), { operation: "search", lockBaseDir: base });

		try {
			assert.throws(
				() => acquireProfileLock(config(profile), { operation: "verify", lockBaseDir: base }),
				(err) => {
					assert.equal(err.code, "WEB_SEARCH_BUSY");
					assert.match(err.message, /Retry this command after about 60 seconds/);
					assert.match(err.message, /Owner PID/);
					assert.match(err.message, /Owner operation/);
					assert.ok(!err.message.includes(profile));
					assert.ok(!err.message.includes("secret-token"));
					return true;
				},
			);
		} finally {
			first.release();
		}
	});

	test("removes a stale dead-pid lock and acquires once", () => {
		const base = tmpRoot("stale");
		const profile = tmpRoot("profile");
		mkdirSync(profile, { recursive: true });
		mkdirSync(base, { recursive: true });

		const hash = profileHashForConfig(config(profile));
		const staleDir = join(base, `${hash}.lock`);
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(join(staleDir, "metadata.json"), JSON.stringify({
			pid: 99999999,
			startedAt: "2020-01-01T00:00:00.000Z",
			operation: "search",
			profileHash: hash,
		}));

		const lock = acquireProfileLock(config(profile), { operation: "content", lockBaseDir: base });
		try {
			const metadata = JSON.parse(readFileSync(join(lock.path, "metadata.json"), "utf-8"));
			assert.equal(metadata.pid, process.pid);
			assert.equal(metadata.operation, "content");
		} finally {
			lock.release();
		}
	});

	test("stale cleanup does not remove a newly-created live lock", () => {
		const base = tmpRoot("stale-race");
		const profile = tmpRoot("profile");
		mkdirSync(profile, { recursive: true });
		mkdirSync(base, { recursive: true });

		const hash = profileHashForConfig(config(profile));
		const staleDir = join(base, `${hash}.lock`);
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(join(staleDir, "metadata.json"), JSON.stringify({
			pid: 99999999,
			startedAt: "2020-01-01T00:00:00.000Z",
			operation: "stale-search",
			profileHash: hash,
		}));

		assert.throws(
			() => acquireProfileLock(config(profile), {
				operation: "content",
				lockBaseDir: base,
				onStaleLockObserved() {
					// Simulate another process winning stale recovery after this process
					// observed the dead PID but before it removes anything.
					rmSync(staleDir, { recursive: true, force: true });
					mkdirSync(staleDir, { recursive: true });
					writeFileSync(join(staleDir, "metadata.json"), JSON.stringify({
						pid: process.pid,
						startedAt: "2026-01-01T00:00:00.000Z",
						operation: "live-search",
						profileHash: hash,
					}));
				},
			}),
			{ code: "WEB_SEARCH_BUSY" },
		);

		assert.ok(existsSync(staleDir), "new live lock should remain");
		const metadata = JSON.parse(readFileSync(join(staleDir, "metadata.json"), "utf-8"));
		assert.equal(metadata.pid, process.pid);
		assert.equal(metadata.operation, "live-search");
	});

	test("release is idempotent and removes only the owned lock", () => {
		const base = tmpRoot("release");
		const profile = tmpRoot("profile");
		mkdirSync(profile, { recursive: true });

		const lock = acquireProfileLock(config(profile), { operation: "verify", lockBaseDir: base });
		lock.release();
		lock.release();

		assert.throws(
			() => readFileSync(join(lock.path, "metadata.json"), "utf-8"),
			{ code: "ENOENT" },
		);
	});
});

import { createHash } from "crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "fs";
import { basename, dirname, join, normalize, resolve } from "path";
import { tmpdir, userInfo } from "os";
import { WebSearchBusyError } from "./errors.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HASH_LENGTH = 32;
const METADATA_FILE = "metadata.json";
const RECOVERY_LOCK_SUFFIX = ".recovery";
const DEFAULT_RECOVERY_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RECOVERY_RETRY_DELAY_MS = 25;

function currentUid() {
	if (typeof process.getuid === "function") return process.getuid();
	return userInfo().uid ?? "unknown";
}

/**
 * Return the directory used for browser-profile locks.
 */
export function defaultLockBaseDir(env = process.env) {
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "web-search", "locks");
	return join(tmpdir(), `web-search-locks-${currentUid()}`);
}

/**
 * Normalize the configured browser profile path before hashing it.
 */
export function normalizeProfilePath(userDataDir) {
	const resolved = resolve(userDataDir);
	try {
		return normalize(realpathSync.native(resolved));
	} catch {
		return normalize(resolved);
	}
}

/**
 * Hash the browser profile identity without exposing the full path.
 */
export function profileHashForConfig(config) {
	const userDataDir = config.browser?.userDataDir;
	if (!userDataDir || typeof userDataDir !== "string") {
		throw new Error("Missing browser.userDataDir; cannot acquire web-search profile lock.");
	}

	return createHash("sha256")
		.update(normalizeProfilePath(userDataDir))
		.digest("hex")
		.slice(0, HASH_LENGTH);
}

function ensurePrivateDir(dir) {
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	try { chmodSync(dir, DIR_MODE); } catch { /* best effort */ }
}

function ensureLockBaseDir(baseDir) {
	ensurePrivateDir(baseDir);

	// For the XDG path, keep the web-search parent private too without touching
	// $XDG_RUNTIME_DIR itself. The /tmp fallback has no extra parent directory.
	const parent = dirname(baseDir);
	if (basename(parent) === "web-search") {
		try { chmodSync(parent, DIR_MODE); } catch { /* best effort */ }
	}
}

function lockPath(baseDir, profileHash) {
	return join(baseDir, `${profileHash}.lock`);
}

function recoveryLockPath(baseDir, profileHash) {
	return join(baseDir, `${profileHash}${RECOVERY_LOCK_SUFFIX}`);
}

function metadataPath(lockDir) {
	return join(lockDir, METADATA_FILE);
}

function readMetadata(lockDir) {
	try {
		return JSON.parse(readFileSync(metadataPath(lockDir), "utf-8"));
	} catch {
		return null;
	}
}

function writeMetadata(lockDir, metadata) {
	writeFileSync(metadataPath(lockDir), `${JSON.stringify(metadata, null, 2)}\n`, { mode: FILE_MODE });
}

function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

function busy(lockDir, profileHash, observedMetadata, requestedOperation) {
	throw new WebSearchBusyError({
		profileHash,
		ownerPid: observedMetadata?.pid,
		ownerOperation: observedMetadata?.operation,
		ownerStartedAt: observedMetadata?.startedAt,
		requestedOperation,
		metadataReadable: Boolean(observedMetadata),
		lockDirExists: existsSync(lockDir),
	});
}

function makeMetadata(profileHash, operation) {
	return {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		operation,
		profileHash,
	};
}

function createLock(lockDir, metadata) {
	mkdirSync(lockDir, { mode: DIR_MODE });
	try { chmodSync(lockDir, DIR_MODE); } catch { /* best effort */ }
	try {
		writeMetadata(lockDir, metadata);
	} catch (err) {
		rmSync(lockDir, { recursive: true, force: true });
		throw err;
	}
}

function ownsLock(lockDir, profileHash) {
	const metadata = readMetadata(lockDir);
	return metadata?.pid === process.pid && metadata?.profileHash === profileHash;
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireRecoveryMutex(recoveryDir, profileHash, operation, { timeoutMs, retryDelayMs }) {
	const metadata = makeMetadata(profileHash, "stale-lock-recovery");
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		try {
			createLock(recoveryDir, metadata);
			return () => {
				if (ownsLock(recoveryDir, profileHash)) {
					rmSync(recoveryDir, { recursive: true, force: true });
				}
			};
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;

			if (Date.now() >= deadline) {
				busy(recoveryDir, profileHash, readMetadata(recoveryDir), operation);
			}
			sleepSync(retryDelayMs);
		}
	}
}

function recoverStaleLockAndCreate(lockDir, recoveryDir, profileHash, metadata, operation, recoveryOptions) {
	const releaseRecovery = acquireRecoveryMutex(recoveryDir, profileHash, operation, recoveryOptions);
	try {
		const current = readMetadata(lockDir);
		if (!current?.pid || isPidAlive(current.pid)) {
			busy(lockDir, profileHash, current, operation);
		}

		// Only the holder of the per-profile recovery mutex may remove a stale
		// profile lock. Re-reading the metadata while holding the mutex prevents a
		// process that saw an old dead PID from deleting a newer live lock created
		// by another recovery winner.
		rmSync(lockDir, { recursive: true, force: true });

		try {
			createLock(lockDir, metadata);
		} catch (retryErr) {
			if (retryErr?.code === "EEXIST") busy(lockDir, profileHash, readMetadata(lockDir), operation);
			throw retryErr;
		}
	} finally {
		releaseRecovery();
	}
}

/**
 * Acquire an atomic lock for the configured browser profile.
 *
 * If another live process owns the lock, this throws WebSearchBusyError. If the
 * owner PID is dead, the stale lock is removed and acquisition is retried once.
 */
export function acquireProfileLock(config, {
	operation = "browser",
	lockBaseDir = defaultLockBaseDir(),
	recoveryLockTimeoutMs = DEFAULT_RECOVERY_LOCK_TIMEOUT_MS,
	recoveryRetryDelayMs = DEFAULT_RECOVERY_RETRY_DELAY_MS,
	onStaleLockObserved,
} = {}) {
	const profileHash = profileHashForConfig(config);
	ensureLockBaseDir(lockBaseDir);

	const dir = lockPath(lockBaseDir, profileHash);
	const recoveryDir = recoveryLockPath(lockBaseDir, profileHash);
	const metadata = makeMetadata(profileHash, operation);

	try {
		createLock(dir, metadata);
	} catch (err) {
		if (err?.code !== "EEXIST") throw err;

		const observed = readMetadata(dir);
		if (!observed?.pid || isPidAlive(observed.pid)) {
			busy(dir, profileHash, observed, operation);
		}

		onStaleLockObserved?.({ lockDir: dir, observedMetadata: observed, profileHash });
		recoverStaleLockAndCreate(dir, recoveryDir, profileHash, metadata, operation, {
			timeoutMs: recoveryLockTimeoutMs,
			retryDelayMs: recoveryRetryDelayMs,
		});
	}

	let released = false;
	return {
		profileHash,
		path: dir,
		release() {
			if (released) return;
			released = true;
			if (!ownsLock(dir, profileHash)) return;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

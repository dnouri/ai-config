import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Exact copy of withBrowserRetry from web.js — tested in isolation.
 *
 * We duplicate rather than import because web.js is a script with
 * top-level side effects (process.argv parsing, process.exit).
 * The function is small and stable enough that duplication is the
 * lesser evil.
 */
async function withBrowserRetry(fn, { retries = 2, delays = [5_000, 15_000] } = {}) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const retryable = err.code === "BROWSER_UNAVAILABLE" && attempt < retries;
			if (!retryable) throw err;
			const delay = delays[Math.min(attempt, delays.length - 1)];
			console.error(`Browser busy — retrying in ${delay / 1000}s... (attempt ${attempt + 2}/${retries + 1})`);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}
}

function browserUnavailableError() {
	const err = new Error("Could not connect to the automation browser.");
	err.code = "BROWSER_UNAVAILABLE";
	return err;
}

describe("withBrowserRetry", () => {
	test("returns result on first success", async () => {
		const result = await withBrowserRetry(() => "ok");
		assert.equal(result, "ok");
	});

	test("retries on BROWSER_UNAVAILABLE and succeeds", async () => {
		let calls = 0;
		const result = await withBrowserRetry(() => {
			calls++;
			if (calls < 2) throw browserUnavailableError();
			return "recovered";
		}, { delays: [10] });

		assert.equal(result, "recovered");
		assert.equal(calls, 2);
	});

	test("does not retry on non-BROWSER_UNAVAILABLE errors", async () => {
		let calls = 0;
		await assert.rejects(
			() => withBrowserRetry(() => {
				calls++;
				throw new Error("something else");
			}, { delays: [10] }),
			{ message: "something else" },
		);
		assert.equal(calls, 1, "should not retry on unrelated errors");
	});

	test("gives up after exhausting retries", async () => {
		let calls = 0;
		await assert.rejects(
			() => withBrowserRetry(() => {
				calls++;
				throw browserUnavailableError();
			}, { retries: 2, delays: [10, 10] }),
			{ code: "BROWSER_UNAVAILABLE" },
		);
		assert.equal(calls, 3, "1 initial + 2 retries = 3 total");
	});

	test("respects delay between retries", async () => {
		const start = Date.now();
		let calls = 0;
		await withBrowserRetry(() => {
			calls++;
			if (calls < 3) throw browserUnavailableError();
			return "ok";
		}, { retries: 2, delays: [50, 100] });

		const elapsed = Date.now() - start;
		// Should have waited ~150ms total (50 + 100)
		assert.ok(elapsed >= 120, `elapsed ${elapsed}ms — should be ≥120ms`);
		assert.ok(elapsed < 500, `elapsed ${elapsed}ms — should be <500ms`);
	});

	test("preserves the original error on final failure", async () => {
		const original = browserUnavailableError();
		original.extra = "context";
		await assert.rejects(
			() => withBrowserRetry(() => { throw original; }, { retries: 0 }),
			(err) => {
				assert.equal(err, original, "should throw the exact same error object");
				assert.equal(err.extra, "context");
				return true;
			},
		);
	});
});

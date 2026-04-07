import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	buildChildProcessArgs,
	buildPiInvocation,
	collectRequestedAgentNames,
	detectInvocationMode,
	normalizeInvocationParams,
	parseToolCallDisplay,
	shortenPath,
} from "./subagent-core.js";

describe("buildPiInvocation", () => {
	test("uses the current script when running under a generic runtime", () => {
		assert.deepEqual(
			buildPiInvocation({
				processExecPath: "/usr/bin/node",
				currentScript: "/tmp/pi.js",
				currentScriptExists: true,
				args: ["--mode", "json"],
			}),
			{ command: "/usr/bin/node", args: ["/tmp/pi.js", "--mode", "json"] },
		);
	});

	test("does not prepend a bunfs script path when already running via the pi executable", () => {
		assert.deepEqual(
			buildPiInvocation({
				processExecPath: "/home/daniel/bin/pi",
				currentScript: "/$bunfs/root/pi",
				currentScriptExists: true,
				args: ["--mode", "json", "-p", "Task: Reply with exactly OK"],
			}),
			{ command: "/home/daniel/bin/pi", args: ["--mode", "json", "-p", "Task: Reply with exactly OK"] },
		);
	});

	test("falls back to the pi command when running in a generic runtime without a script path", () => {
		assert.deepEqual(
			buildPiInvocation({
				processExecPath: "/usr/bin/bun",
				currentScript: undefined,
				currentScriptExists: false,
				args: ["--mode", "json"],
			}),
			{ command: "pi", args: ["--mode", "json"] },
		);
	});
});

describe("buildChildProcessArgs", () => {
	test("builds child pi argv that persists sessions by default", () => {
		const args = buildChildProcessArgs({ task: "Inspect auth flow" });
		assert.deepEqual(args, ["--mode", "json", "-p", "Task: Inspect auth flow"]);
	});

	test("places -p immediately before the prompt, after all other flags", () => {
		const args = buildChildProcessArgs({
			task: "Summarize findings",
			model: "anthropic/claude-sonnet-4-5",
			tools: ["read", "grep"],
			systemPromptPath: "/tmp/prompt.md",
		});
		assert.deepEqual(args, [
			"--mode",
			"json",
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--tools",
			"read,grep",
			"--append-system-prompt",
			"/tmp/prompt.md",
			"-p",
			"Task: Summarize findings",
		]);
	});
});

describe("detectInvocationMode", () => {
	test("detects single mode when task is present, even if agent is omitted", () => {
		assert.equal(detectInvocationMode({ agent: "worker", task: "Inspect auth" }), "single");
		assert.equal(detectInvocationMode({ task: "Inspect auth" }), "single");
		assert.equal(detectInvocationMode({ agent: "worker" }), null);
	});

	test("detects parallel and chain modes", () => {
		assert.equal(detectInvocationMode({ tasks: [{ agent: "worker", task: "A" }] }), "parallel");
		assert.equal(detectInvocationMode({ chain: [{ agent: "worker", task: "A" }] }), "chain");
	});
});

describe("normalizeInvocationParams", () => {
	const soleAgent = [{ name: "solo", source: "user" }];

	test("fills omitted single-mode agent from the sole discovered agent", () => {
		assert.deepEqual(normalizeInvocationParams({ task: "Inspect auth" }, soleAgent), {
			mode: "single",
			agent: "solo",
			task: "Inspect auth",
			cwd: undefined,
		});
	});

	test("fills omitted parallel-mode agents from the sole discovered agent", () => {
		assert.deepEqual(
			normalizeInvocationParams(
				{
					tasks: [
						{ task: "Inspect auth" },
						{ task: "Summarize findings", cwd: "/tmp/project" },
					],
				},
				soleAgent,
			),
			{
				mode: "parallel",
				tasks: [
					{ agent: "solo", task: "Inspect auth", cwd: undefined },
					{ agent: "solo", task: "Summarize findings", cwd: "/tmp/project" },
				],
			},
		);
	});

	test("fills omitted chain-mode agents from the sole discovered agent", () => {
		assert.deepEqual(
			normalizeInvocationParams(
				{
					chain: [
						{ task: "Inspect auth" },
						{ task: "Use this context: {previous}" },
					],
				},
				soleAgent,
			),
			{
				mode: "chain",
				chain: [
					{ agent: "solo", task: "Inspect auth", cwd: undefined },
					{ agent: "solo", task: "Use this context: {previous}", cwd: undefined },
				],
			},
		);
	});

	test("throws a clear error when omitted agent names are ambiguous", () => {
		assert.throws(
			() =>
				normalizeInvocationParams(
					{ task: "Inspect auth" },
					[
						{ name: "alpha", source: "user" },
						{ name: "beta", source: "project" },
					],
				),
			/omitted agent.*exactly one agent.*Available agents: alpha \(user\), beta \(project\)/i,
		);
	});
});

describe("shortenPath", () => {
	test("replaces the home directory prefix with ~", () => {
		assert.equal(shortenPath("/home/user/project/file.ts", "/home/user"), "~/project/file.ts");
	});

	test("returns the path unchanged when it does not start with homedir", () => {
		assert.equal(shortenPath("/tmp/file.ts", "/home/user"), "/tmp/file.ts");
	});

	test("returns '...' for falsy input", () => {
		assert.equal(shortenPath(undefined, "/home/user"), "...");
		assert.equal(shortenPath(null, "/home/user"), "...");
		assert.equal(shortenPath("", "/home/user"), "...");
	});
});

describe("parseToolCallDisplay", () => {
	const home = "/home/user";

	test("bash: returns command preview with output style", () => {
		const d = parseToolCallDisplay("bash", { command: "ls -la" }, home);
		assert.deepEqual(d, { label: "$ ", primary: "ls -la", primaryStyle: "output" });
	});

	test("bash: truncates long commands", () => {
		const long = "a".repeat(80);
		const d = parseToolCallDisplay("bash", { command: long }, home);
		assert.equal(d.primary, "a".repeat(60) + "...");
	});

	test("read: shows shortened path with optional range", () => {
		const d = parseToolCallDisplay("read", { path: "/home/user/file.ts", offset: 10, limit: 20 }, home);
		assert.equal(d.label, "read ");
		assert.equal(d.primary, "~/file.ts");
		assert.equal(d.secondary, ":10-29");
		assert.equal(d.primaryStyle, "accent");
	});

	test("read: omits range when no offset/limit", () => {
		const d = parseToolCallDisplay("read", { path: "/tmp/file.ts" }, home);
		assert.equal(d.secondary, undefined);
	});

	test("write: includes line count in detail when multi-line", () => {
		const d = parseToolCallDisplay("write", { path: "/home/user/out.ts", content: "a\nb\nc" }, home);
		assert.equal(d.primary, "~/out.ts");
		assert.equal(d.detail, " (3 lines)");
	});

	test("edit, ls: return shortened paths", () => {
		assert.equal(parseToolCallDisplay("edit", { path: "/home/user/f.ts" }, home).primary, "~/f.ts");
		assert.equal(parseToolCallDisplay("ls", { path: "/home/user/src" }, home).primary, "~/src");
	});

	test("find, grep: include pattern and location", () => {
		const find = parseToolCallDisplay("find", { pattern: "*.ts", path: "/home/user/src" }, home);
		assert.equal(find.primary, "*.ts");
		assert.equal(find.detail, " in ~/src");

		const grep = parseToolCallDisplay("grep", { pattern: "TODO", path: "/home/user/src" }, home);
		assert.equal(grep.primary, "/TODO/");
		assert.equal(grep.detail, " in ~/src");
	});

	test("unknown tools: show name and args preview", () => {
		const d = parseToolCallDisplay("custom_tool", { foo: "bar" }, home);
		assert.equal(d.label, "");
		assert.equal(d.primary, "custom_tool");
		assert.equal(d.primaryStyle, "accent");
		assert.equal(d.detail, ' {"foo":"bar"}');
	});
});

describe("collectRequestedAgentNames", () => {
	test("collects unique agent names across all current parameter shapes", () => {
		assert.deepEqual(
			collectRequestedAgentNames({
				agent: "worker",
				tasks: [
					{ agent: "worker", task: "A" },
					{ agent: "reviewer", task: "B" },
				],
				chain: [{ agent: "planner", task: "C" }],
			}),
			["planner", "worker", "reviewer"],
		);
	});

	test("collects inferred agent names after normalization for confirmation flow", () => {
		const normalized = normalizeInvocationParams(
			{ task: "Inspect auth" },
			[{ name: "solo", source: "project" }],
		);
		assert.deepEqual(collectRequestedAgentNames(normalized), ["solo"]);
	});
});

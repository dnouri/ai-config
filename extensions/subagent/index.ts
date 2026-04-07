/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
	buildChildProcessArgs,
	buildPiInvocation,
	collectRequestedAgentNames,
	detectInvocationMode,
	formatAvailableAgents,
	normalizeInvocationParams,
} from "./subagent-core.js";
import {
	applyChildEvent,
	createSingleResult,
	finalizeSingleResult,
	getBestAvailableContent,
	getStreamingDisplayContent,
	isResultError,
	isResultRunning,
} from "./subagent-stream.js";
import { renderCall, renderResult } from "./subagent-render.js";
import type { SingleResult, SubagentDetails } from "./subagent-types.js";

function formatElapsed(startTime: number): string {
	const sec = (Date.now() - startTime) / 1000;
	if (sec < 60) return `${sec.toFixed(0)}s`;
	const min = Math.floor(sec / 60);
	return `${min}m${Math.floor(sec % 60)}s`;
}

function formatStreamingStats(r: SingleResult, startTime: number): string {
	const parts: string[] = [];
	if (r.usage.turns) parts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
	if (r.usage.input || r.usage.output) parts.push(`↑${r.usage.input} ↓${r.usage.output}`);
	if (r.usage.cost) parts.push(`$${r.usage.cost.toFixed(4)}`);
	const toolCount = r.toolExecutions.length;
	if (toolCount) parts.push(`${toolCount} tool${toolCount > 1 ? "s" : ""}`);
	parts.push(formatElapsed(startTime));
	return parts.join(" · ");
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const UPDATE_THROTTLE_MS = 500;

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	return buildPiInvocation({
		processExecPath: process.execPath,
		currentScript,
		currentScriptExists: Boolean(currentScript && fs.existsSync(currentScript)),
		args,
	});
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const missingAgentResult = createSingleResult({
			agent: agentName,
			agentSource: "unknown",
			task,
			step,
		}) as SingleResult;
		missingAgentResult.stderr = `Unknown agent: "${agentName}". Available agents: ${available}.`;
		return finalizeSingleResult(missingAgentResult, 1) as SingleResult;
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult = createSingleResult({
		agent: agentName,
		agentSource: agent.source,
		task,
		model: agent.model,
		step,
	}) as SingleResult;

	const startTime = Date.now();

	const doEmitUpdate = () => {
		if (onUpdate) {
			const text = getStreamingDisplayContent(currentResult)
				+ `\n\n${formatStreamingStats(currentResult, startTime)}`;
			onUpdate({
				content: [{ type: "text", text }],
				details: makeDetails([currentResult]),
			});
		}
	};

	// Throttle streaming updates so the TUI is not flooded.
	// Boundary events (message_end, tool_execution_start/end) emit immediately;
	// high-frequency events (message_update, tool_execution_update) are batched.
	let throttleTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingUpdate = false;

	const emitUpdate = (immediate = false) => {
		if (immediate) {
			if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
			pendingUpdate = false;
			doEmitUpdate();
			return;
		}
		pendingUpdate = true;
		if (!throttleTimer) {
			throttleTimer = setTimeout(() => {
				throttleTimer = null;
				if (pendingUpdate) { pendingUpdate = false; doEmitUpdate(); }
			}, UPDATE_THROTTLE_MS);
		}
	};

	const flushPendingUpdate = () => {
		if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
		if (pendingUpdate) { pendingUpdate = false; doEmitUpdate(); }
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}

		const args = buildChildProcessArgs({
			task,
			model: agent.model,
			tools: agent.tools,
			systemPromptPath: tmpPromptPath ?? undefined,
		});
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const BOUNDARY_EVENTS = new Set([
				"message_end", "tool_execution_start", "tool_execution_end", "tool_result_end",
			]);

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (applyChildEvent(currentResult, event)) {
					emitUpdate(BOUNDARY_EVENTS.has(event.type));
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				flushPendingUpdate();
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		finalizeSingleResult(currentResult, exitCode);
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// ── Tool schema ───────────────────────────────────────────────

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke. Optional when exactly one agent is discovered." })),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke. Optional when exactly one agent is discovered." }),
	),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (for single mode). Optional when exactly one agent is discovered." }),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description:
				"Array of parallel task items. Each item may omit agent when exactly one agent is discovered.",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description:
				"Array of sequential chain items. Each item may omit agent when exactly one agent is discovered.",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// ── Extension entry point ─────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"If exactly one agent is discovered, omitted agent names default to that agent; otherwise omission is an error.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const available = formatAvailableAgents(agents);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			let normalized;
			try {
				normalized = normalizeInvocationParams(params, agents);
			} catch (error) {
				const mode = detectInvocationMode(params) ?? "single";
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: message }],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}

			if (!normalized) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = collectRequestedAgentNames(normalized);

				const projectAgentsRequested = requestedAgentNames
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(normalized.mode)([]),
						};
				}
			}

			if (normalized.mode === "chain") {
				return executeChain(ctx.cwd, agents, normalized.chain, signal, onUpdate, makeDetails("chain"));
			}

			if (normalized.mode === "parallel") {
				return executeParallel(ctx.cwd, agents, normalized.tasks, signal, onUpdate, makeDetails("parallel"));
			}

			if (normalized.mode === "single") {
				return executeSingle(ctx.cwd, agents, normalized, signal, onUpdate, makeDetails("single"));
			}

			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall,
		renderResult,
	});
}

// ── Mode execution helpers ────────────────────────────────────

async function executeChain(
	cwd: string,
	agents: AgentConfig[],
	chain: { agent: string; task: string; cwd?: string }[],
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
) {
	const results: SingleResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

		const chainUpdate: OnUpdateCallback | undefined = onUpdate
			? (partial) => {
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						onUpdate({
							content: partial.content,
							details: makeDetails([...results, currentResult]),
						});
					}
				}
			: undefined;

		const result = await runSingleAgent(
			cwd,
			agents,
			step.agent,
			taskWithContext,
			step.cwd,
			i + 1,
			signal,
			chainUpdate,
			makeDetails,
		);
		results.push(result);

		const isError = isResultError(result);
		if (isError) {
			const errorMsg = result.errorMessage || result.stderr || getBestAvailableContent(result) || "(no output)";
			return {
				content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
				details: makeDetails(results),
				isError: true,
			};
		}
		previousOutput = getBestAvailableContent(result);
	}

	return {
		content: [{ type: "text", text: getBestAvailableContent(results[results.length - 1]) || "(no output)" }],
		details: makeDetails(results),
	};
}

async function executeParallel(
	cwd: string,
	agents: AgentConfig[],
	tasks: { agent: string; task: string; cwd?: string }[],
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
) {
	if (tasks.length > MAX_PARALLEL_TASKS)
		return {
			content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
			details: makeDetails([]),
		};

	const allResults: SingleResult[] = new Array(tasks.length);

	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = createSingleResult({
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
		}) as SingleResult;
	}

	const emitParallelUpdate = () => {
		if (onUpdate) {
			const running = allResults.filter((r) => isResultRunning(r)).length;
			const done = allResults.filter((r) => !isResultRunning(r)).length;
			onUpdate({
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
				details: makeDetails([...allResults]),
			});
		}
	};

	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
		const result = await runSingleAgent(
			cwd,
			agents,
			t.agent,
			t.task,
			t.cwd,
			undefined,
			signal,
			(partial) => {
				if (partial.details?.results[0]) {
					allResults[index] = partial.details.results[0];
					emitParallelUpdate();
				}
			},
			makeDetails,
		);
		allResults[index] = result;
		emitParallelUpdate();
		return result;
	});

	const successCount = results.filter((r) => r.exitCode === 0).length;
	const summaries = results.map((r) => {
		const output = getBestAvailableContent(r);
		const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
		return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
	});

	return {
		content: [
			{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` },
		],
		details: makeDetails(results),
	};
}

async function executeSingle(
	cwd: string,
	agents: AgentConfig[],
	normalized: { agent: string; task: string; cwd?: string },
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
) {
	const result = await runSingleAgent(
		cwd,
		agents,
		normalized.agent,
		normalized.task,
		normalized.cwd,
		undefined,
		signal,
		onUpdate,
		makeDetails,
	);

	const isError = isResultError(result);
	if (isError) {
		const errorMsg = result.errorMessage || result.stderr || getBestAvailableContent(result) || "(no output)";
		return {
			content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
			details: makeDetails([result]),
			isError: true,
		};
	}

	return {
		content: [{ type: "text", text: getBestAvailableContent(result) || "(no output)" }],
		details: makeDetails([result]),
	};
}

/**
 * Determine how to spawn a child `pi` process.
 *
 * @param {{ processExecPath: string, currentScript: string | undefined, currentScriptExists: boolean, args: string[] }} opts
 * @returns {{ command: string, args: string[] }}
 */
export function buildPiInvocation({ processExecPath, currentScript, currentScriptExists, args }) {
	const execName = processExecPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

	if (isGenericRuntime && currentScript && currentScriptExists) {
		return { command: processExecPath, args: [currentScript, ...args] };
	}
	if (!isGenericRuntime) {
		return { command: processExecPath, args };
	}
	return { command: "pi", args };
}

/**
 * Build the argv for a child `pi` process.
 *
 * Flags are placed before `-p` so the prompt string is always the
 * final positional argument.
 *
 * @param {{ task: string, model?: string, tools?: string[], systemPromptPath?: string }} opts
 * @returns {string[]}
 */
export function buildChildProcessArgs({ task, model, tools, systemPromptPath }) {
	const args = ["--mode", "json"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
	args.push("-p", `Task: ${task}`);
	return args;
}

/**
 * Determine which invocation mode the caller intended.
 *
 * Returns `"single"`, `"parallel"`, or `"chain"` when exactly one mode
 * is present, or `null` when the params are ambiguous or empty.
 *
 * @param {{ task?: string, tasks?: unknown[], chain?: unknown[] }} params
 * @returns {"single" | "parallel" | "chain" | null}
 */
export function detectInvocationMode(params) {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = typeof params.task === "string";
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

	if (modeCount !== 1) return null;
	if (hasChain) return "chain";
	if (hasTasks) return "parallel";
	if (hasSingle) return "single";
	return null;
}

/**
 * Format a discovered agent list for user-facing messages.
 *
 * @param {{ name: string, source?: string }[]} agents
 * @returns {string}
 */
export function formatAvailableAgents(agents) {
	return agents.map((a) => `${a.name} (${a.source ?? "unknown"})`).join(", ") || "none";
}

/**
 * Resolve an optional agent name against the discovered agent set.
 *
 * @param {string | undefined} agentName
 * @param {{ name: string, source?: string }[]} agents
 * @returns {string}
 * @throws {Error} when the name is omitted and resolution is ambiguous
 */
function resolveAgentName(agentName, agents) {
	if (agentName) return agentName;
	if (agents.length === 1) return agents[0].name;
	throw new Error(
		`Omitted agent could not be resolved. Specify agent explicitly unless exactly one agent is discovered. Available agents: ${formatAvailableAgents(agents)}.`,
	);
}

/**
 * Normalize raw tool params into a mode-tagged object with all agent
 * names resolved.  Returns `null` when no valid mode is detected.
 *
 * @param {Record<string, unknown>} params  - raw tool call parameters
 * @param {{ name: string, source?: string }[]} agents - discovered agents
 * @returns {{ mode: "single", agent: string, task: string, cwd?: string }
 *         | { mode: "parallel", tasks: { agent: string, task: string, cwd?: string }[] }
 *         | { mode: "chain", chain: { agent: string, task: string, cwd?: string }[] }
 *         | null}
 */
export function normalizeInvocationParams(params, agents) {
	const mode = detectInvocationMode(params);
	if (!mode) return null;

	if (mode === "single") {
		return {
			mode,
			agent: resolveAgentName(params.agent, agents),
			task: params.task,
			cwd: params.cwd,
		};
	}

	if (mode === "parallel") {
		return {
			mode,
			tasks: params.tasks.map((t) => ({
				agent: resolveAgentName(t.agent, agents),
				task: t.task,
				cwd: t.cwd,
			})),
		};
	}

	return {
		mode,
		chain: params.chain.map((s) => ({
			agent: resolveAgentName(s.agent, agents),
			task: s.task,
			cwd: s.cwd,
		})),
	};
}

/**
 * Shorten a file path by replacing the home directory prefix with `~`.
 *
 * @param {string | undefined | null} filePath
 * @param {string} homedir
 * @returns {string}
 */
export function shortenPath(filePath, homedir) {
	if (!filePath || typeof filePath !== "string") return "...";
	return homedir && filePath.startsWith(homedir) ? `~${filePath.slice(homedir.length)}` : filePath;
}

/**
 * Parse a tool call into structured display parts for formatting.
 *
 * Consumers render these parts as plain text or with theme colors,
 * keeping the tool-specific switch logic in one place.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} [args]
 * @param {string} [homedir]
 * @returns {{ label: string, primary: string, primaryStyle: "output" | "accent", secondary?: string, detail?: string }}
 */
export function parseToolCallDisplay(toolName, args = {}, homedir = "") {
	const shorten = (p) => shortenPath(p, homedir);

	switch (toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return { label: "$ ", primary: preview, primaryStyle: "output" };
		}
		case "read": {
			const filePath = shorten(args.file_path || args.path);
			const offset = Number.isInteger(args.offset) ? args.offset : undefined;
			const limit = Number.isInteger(args.limit) ? args.limit : undefined;
			let secondary;
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				secondary = `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return { label: "read ", primary: filePath, primaryStyle: "accent", secondary };
		}
		case "write": {
			const filePath = shorten(args.file_path || args.path);
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content.split("\n").length;
			const detail = lines > 1 ? ` (${lines} lines)` : undefined;
			return { label: "write ", primary: filePath, primaryStyle: "accent", detail };
		}
		case "edit":
			return { label: "edit ", primary: shorten(args.file_path || args.path), primaryStyle: "accent" };
		case "ls":
			return { label: "ls ", primary: shorten(args.path || "."), primaryStyle: "accent" };
		case "find":
			return {
				label: "find ",
				primary: String(args.pattern || "*"),
				primaryStyle: "accent",
				detail: ` in ${shorten(args.path || ".")}`,
			};
		case "grep":
			return {
				label: "grep ",
				primary: `/${args.pattern || ""}/`,
				primaryStyle: "accent",
				detail: ` in ${shorten(args.path || ".")}`,
			};
		default: {
			const argsText = JSON.stringify(args);
			const preview = argsText.length > 50 ? `${argsText.slice(0, 50)}...` : argsText;
			return { label: "", primary: toolName, primaryStyle: "accent", detail: ` ${preview}` };
		}
	}
}

/**
 * Collect unique agent names from (possibly normalized) params.
 *
 * Works on both raw and normalized shapes so it can be called after
 * normalization to feed the project-agent confirmation flow.
 *
 * @param {{ agent?: string, tasks?: { agent?: string }[], chain?: { agent?: string }[] }} params
 * @returns {string[]}
 */
export function collectRequestedAgentNames(params) {
	const names = new Set();
	if (params.chain) {
		for (const step of params.chain) {
			if (step.agent) names.add(step.agent);
		}
	}
	if (params.tasks) {
		for (const task of params.tasks) {
			if (task.agent) names.add(task.agent);
		}
	}
	if (params.agent) names.add(params.agent);
	return Array.from(names);
}

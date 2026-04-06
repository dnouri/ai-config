/**
 * Rendering helpers for the subagent tool.
 *
 * Separated from index.ts so execution logic and presentation
 * can evolve independently.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { AgentScope } from "./agents.js";
import { parseToolCallDisplay } from "./subagent-core.js";
import {
	getDisplayItems as getStreamDisplayItems,
	getFinalOutput as getStreamFinalOutput,
	isResultError,
	isResultRunning,
} from "./subagent-stream.js";
import type { DisplayItem, SingleResult, SubagentDetails } from "./subagent-types.js";

export type { SingleResult, SubagentDetails } from "./subagent-types.js";

// ── Formatting helpers ────────────────────────────────────────

const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

const PRIMARY_STYLE_COLOR: Record<string, string> = { output: "toolOutput", accent: "accent" };

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const d = parseToolCallDisplay(toolName, args, os.homedir());
	let text = d.label ? themeFg("muted", d.label) : "";
	text += themeFg(PRIMARY_STYLE_COLOR[d.primaryStyle] || "accent", d.primary);
	if (d.secondary) text += themeFg("warning", d.secondary);
	if (d.detail) text += themeFg("dim", d.detail);
	return text;
}

function aggregateUsage(results: SingleResult[]) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

function getResultIcon(result: SingleResult, theme: any): string {
	if (isResultRunning(result)) return theme.fg("warning", "⏳");
	return isResultError(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function getResultPlaceholder(result: SingleResult): string {
	return isResultRunning(result) ? "(running...)" : "(no output)";
}

/** Append tool calls, final markdown output, and per-result usage to a container. */
function addExpandedResultBody(container: Container, r: SingleResult, theme: any, mdTheme: any) {
	const displayItems = getStreamDisplayItems(r) as DisplayItem[];
	const finalOutput = getStreamFinalOutput(r);

	for (const item of displayItems) {
		if (item.type === "toolCall") {
			container.addChild(
				new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
			);
		}
	}
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	}

	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
}

/** Append aggregated usage across all results as a total line. */
function addTotalUsage(container: Container, results: SingleResult[], theme: any) {
	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
	}
}

// ── renderCall ────────────────────────────────────────────────

export function renderCall(args: any, theme: any, _context: any) {
	const scope: AgentScope = args.agentScope ?? "user";
	const renderAgentLabel = (agentName?: string) =>
		agentName ? theme.fg("accent", agentName) : theme.fg("warning", "(auto)");

	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			theme.fg("muted", ` [${scope}]`);
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
			const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
			text +=
				"\n  " +
				theme.fg("muted", `${i + 1}.`) +
				" " +
				renderAgentLabel(step.agent) +
				theme.fg("dim", ` ${preview}`);
		}
		if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}

	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`);
		for (const t of args.tasks.slice(0, 3)) {
			const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
			text += `\n  ${renderAgentLabel(t.agent)}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}

	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		renderAgentLabel(args.agent) +
		theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

// ── renderResult ──────────────────────────────────────────────

export function renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, _context: any) {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
		const toShow = limit ? items.slice(-limit) : items;
		const skipped = limit && items.length > limit ? items.length - limit : 0;
		let text = "";
		if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
				text += `${theme.fg("toolOutput", preview)}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
			}
		}
		return text.trimEnd();
	};

	if (details.mode === "single" && details.results.length === 1) {
		return renderSingleResult(details.results[0], expanded, theme, mdTheme, renderDisplayItems);
	}
	if (details.mode === "chain") {
		return renderChainResult(details, expanded, theme, mdTheme, renderDisplayItems);
	}
	if (details.mode === "parallel") {
		return renderParallelResult(details, expanded, theme, mdTheme, renderDisplayItems);
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}

function renderSingleResult(
	r: SingleResult,
	expanded: boolean,
	theme: any,
	mdTheme: any,
	renderDisplayItems: (items: DisplayItem[], limit?: number) => string,
) {
	const isError = isResultError(r);
	const icon = getResultIcon(r, theme);
	const displayItems = getStreamDisplayItems(r) as DisplayItem[];
	const finalOutput = getStreamFinalOutput(r);

	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		container.addChild(new Text(header, 0, 0));
		if (isError && r.errorMessage)
			container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", getResultPlaceholder(r)), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(
							theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0,
							0,
						),
					);
				}
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
	else if (displayItems.length === 0) text += `\n${theme.fg("muted", getResultPlaceholder(r))}`;
	else {
		text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
}

function renderChainResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: any,
	mdTheme: any,
	renderDisplayItems: (items: DisplayItem[], limit?: number) => string,
) {
	const runningCount = details.results.filter((r) => isResultRunning(r)).length;
	const successCount = details.results.filter((r) => !isResultRunning(r) && !isResultError(r)).length;
	const failCount = details.results.filter((r) => isResultError(r)).length;
	const icon = runningCount > 0 ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const status = runningCount > 0 ? `${details.results.length - runningCount}/${details.results.length} done, ${runningCount} running` : `${successCount}/${details.results.length} steps`;

	if (expanded) {
		const container = new Container();
		container.addChild(
			new Text(icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", status), 0, 0),
		);

		for (const r of details.results) {
			const rIcon = getResultIcon(r, theme);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
			);
			container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
			addExpandedResultBody(container, r, theme, mdTheme);
		}

		addTotalUsage(container, details.results, theme);
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", status)}`;
	for (const r of details.results) {
		const rIcon = getResultIcon(r, theme);
		const displayItems = getStreamDisplayItems(r) as DisplayItem[];
		text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
		if (displayItems.length === 0) text += `\n${theme.fg("muted", getResultPlaceholder(r))}`;
		else text += `\n${renderDisplayItems(displayItems, 5)}`;
	}
	const usageStr = formatUsageStats(aggregateUsage(details.results));
	if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderParallelResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: any,
	mdTheme: any,
	renderDisplayItems: (items: DisplayItem[], limit?: number) => string,
) {
	const running = details.results.filter((r) => isResultRunning(r)).length;
	const successCount = details.results.filter((r) => !isResultRunning(r) && !isResultError(r)).length;
	const failCount = details.results.filter((r) => isResultError(r)).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${successCount}/${details.results.length} tasks`;

	if (expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
		);

		for (const r of details.results) {
			const rIcon = getResultIcon(r, theme);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
			);
			container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
			addExpandedResultBody(container, r, theme, mdTheme);
		}

		addTotalUsage(container, details.results, theme);
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
	for (const r of details.results) {
		const rIcon = getResultIcon(r, theme);
		const displayItems = getStreamDisplayItems(r) as DisplayItem[];
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
		if (displayItems.length === 0) text += `\n${theme.fg("muted", getResultPlaceholder(r))}`;
		else text += `\n${renderDisplayItems(displayItems, 5)}`;
	}
	if (!isRunning) {
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

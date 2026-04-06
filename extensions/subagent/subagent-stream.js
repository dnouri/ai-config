/**
 * Child-event aggregation and display helpers for the subagent extension.
 *
 * This module keeps the child JSON event handling pure and testable so the
 * parent tool can derive both live status text and richer render details from
 * the same state snapshot.
 */

import { parseToolCallDisplay } from "./subagent-core.js";

const HOME = process.env.HOME || "";

function createEmptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function bumpSequence(result) {
	result.streamSequence += 1;
	return result.streamSequence;
}

function extractText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function formatToolCallPreview(toolName, args = {}) {
	const d = parseToolCallDisplay(toolName, args, HOME);
	return d.label + d.primary + (d.secondary || "") + (d.detail || "");
}

function getToolCallParts(message) {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.filter((part) => part?.type === "toolCall");
}

function updateUsageFromAssistant(result, message) {
	result.usage.turns += 1;
	const usage = message.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!result.model && message.model) result.model = message.model;
	if (message.stopReason) result.stopReason = message.stopReason;
	if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function ensureToolExecution(result, toolCallId, toolName, args) {
	let execution = result.toolExecutions.find((entry) => entry.toolCallId === toolCallId);
	if (!execution) {
		execution = {
			toolCallId,
			toolName,
			args: args || {},
			partialResult: undefined,
			result: undefined,
			toolResultMessage: undefined,
			isError: false,
			lastUpdatedAt: result.streamSequence,
		};
		result.toolExecutions.push(execution);
	} else {
		if (toolName) execution.toolName = toolName;
		if (args) execution.args = args;
	}
	return execution;
}

function getLatestExecution(result, pick) {
	let latest = undefined;
	for (const execution of result.toolExecutions) {
		if (!pick(execution)) continue;
		if (!latest || execution.lastUpdatedAt > latest.lastUpdatedAt) {
			latest = execution;
		}
	}
	return latest;
}

function getLastToolCallFromMessage(message) {
	const toolCalls = getToolCallParts(message);
	return toolCalls.at(-1);
}

function getFinalAssistantText(result) {
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const message = result.messages[i];
		if (message.role !== "assistant") continue;
		const text = extractText(message.content);
		if (text) return text;
	}
	return "";
}

function getPartialAssistantText(result) {
	if (!result.partialAssistantMessage) return "";
	return extractText(result.partialAssistantMessage.content);
}

function getFinalToolOutput(result) {
	const latest = getLatestExecution(
		result,
		(execution) => extractText(execution.toolResultMessage?.content || execution.result?.content),
	);
	if (!latest) return "";
	return extractText(latest.toolResultMessage?.content || latest.result?.content);
}

function getPartialToolOutput(result) {
	const latest = getLatestExecution(result, (execution) => {
		if (execution.toolResultMessage || execution.result) return false;
		return Boolean(extractText(execution.partialResult?.content));
	});
	if (!latest) return "";
	return extractText(latest.partialResult?.content);
}

function getToolCallPreview(result) {
	const partialToolCall = getLastToolCallFromMessage(result.partialAssistantMessage);
	if (partialToolCall) return formatToolCallPreview(partialToolCall.name, partialToolCall.arguments);

	for (let i = result.messages.length - 1; i >= 0; i--) {
		const toolCall = getLastToolCallFromMessage(result.messages[i]);
		if (toolCall) return formatToolCallPreview(toolCall.name, toolCall.arguments);
	}

	const latestExecution = getLatestExecution(result, () => true);
	if (!latestExecution) return "";
	return formatToolCallPreview(latestExecution.toolName, latestExecution.args);
}

export function createSingleResult({ agent, agentSource, task, model, step }) {
	return {
		agent,
		agentSource,
		task,
		status: "running",
		exitCode: null,
		messages: [],
		stderr: "",
		usage: createEmptyUsage(),
		model,
		step,
		partialAssistantMessage: undefined,
		toolExecutions: [],
		streamSequence: 0,
	};
}

export function finalizeSingleResult(result, exitCode) {
	result.status = "completed";
	result.exitCode = exitCode;
	return result;
}

export function isResultRunning(result) {
	return result.status !== "completed";
}

export function isResultError(result) {
	return !isResultRunning(result) && (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted");
}

export function applyChildEvent(result, event) {
	if (!event || typeof event !== "object") return false;

	if (event.type === "message_update" && event.message?.role === "assistant") {
		bumpSequence(result);
		result.partialAssistantMessage = event.message;
		return true;
	}

	if (event.type === "message_end" && event.message?.role === "assistant") {
		bumpSequence(result);
		result.partialAssistantMessage = undefined;
		result.messages.push(event.message);
		updateUsageFromAssistant(result, event.message);
		return true;
	}

	if (event.type === "message_end" && event.message?.role === "toolResult") {
		const sequence = bumpSequence(result);
		result.messages.push(event.message);
		const execution = ensureToolExecution(result, event.message.toolCallId, event.message.toolName, undefined);
		execution.toolResultMessage = event.message;
		execution.result = {
			content: event.message.content,
			details: event.message.details,
		};
		execution.isError = event.message.isError;
		execution.lastUpdatedAt = sequence;
		return true;
	}

	if (event.type === "tool_execution_start") {
		const sequence = bumpSequence(result);
		const execution = ensureToolExecution(result, event.toolCallId, event.toolName, event.args);
		execution.lastUpdatedAt = sequence;
		return true;
	}

	if (event.type === "tool_execution_update") {
		const sequence = bumpSequence(result);
		const execution = ensureToolExecution(result, event.toolCallId, event.toolName, event.args);
		execution.partialResult = event.partialResult;
		execution.lastUpdatedAt = sequence;
		return true;
	}

	if (event.type === "tool_execution_end") {
		const sequence = bumpSequence(result);
		const execution = ensureToolExecution(result, event.toolCallId, event.toolName, undefined);
		execution.result = event.result;
		execution.isError = Boolean(event.isError);
		execution.lastUpdatedAt = sequence;
		return true;
	}

	if (event.type === "tool_result_end" && event.message?.role === "toolResult") {
		return applyChildEvent(result, { type: "message_end", message: event.message });
	}

	return false;
}

export function getFinalOutput(result) {
	return getFinalAssistantText(result) || getFinalToolOutput(result);
}

export function getBestAvailableContent(result) {
	return (
		getFinalOutput(result) ||
		getPartialAssistantText(result) ||
		getPartialToolOutput(result) ||
		getToolCallPreview(result) ||
		"(running...)"
	);
}

export function getDisplayItems(result) {
	const items = [];
	const seenToolCalls = new Set();

	for (const message of result.messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				if (part.type === "toolCall") {
					seenToolCalls.add(part.id);
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
		}

		if (message.role === "toolResult") {
			const text = extractText(message.content);
			if (text) items.push({ type: "text", text });
		}
	}

	if (result.partialAssistantMessage) {
		for (const part of result.partialAssistantMessage.content || []) {
			if (part.type === "text") items.push({ type: "text", text: part.text });
			if (part.type === "toolCall") {
				seenToolCalls.add(part.id);
				items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}

	for (const execution of result.toolExecutions) {
		if (!seenToolCalls.has(execution.toolCallId)) {
			items.push({ type: "toolCall", name: execution.toolName, args: execution.args });
			seenToolCalls.add(execution.toolCallId);
		}

		if (execution.toolResultMessage) continue;
		const text = extractText(execution.result?.content || execution.partialResult?.content);
		if (text) items.push({ type: "text", text });
	}

	return items;
}

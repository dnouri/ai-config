import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	applyChildEvent,
	createSingleResult,
	finalizeSingleResult,
	getBestAvailableContent,
	getDisplayItems,
	getStreamingDisplayContent,
} from "./subagent-stream.js";

function createAssistantMessage(content, overrides = {}) {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: overrides.model ?? "anthropic/claude-sonnet-4-5",
		usage:
			overrides.usage ?? {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

function createToolResultMessage(text, overrides = {}) {
	return {
		role: "toolResult",
		toolCallId: overrides.toolCallId ?? "call-1",
		toolName: overrides.toolName ?? "bash",
		content: [{ type: "text", text }],
		details: overrides.details ?? {},
		isError: overrides.isError ?? false,
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

function createToolCall(name, args, overrides = {}) {
	return {
		type: "toolCall",
		id: overrides.id ?? "call-1",
		name,
		arguments: args,
	};
}

function createResult() {
	return createSingleResult({
		agent: "worker",
		agentSource: "user",
		task: "Inspect the repository",
		model: "anthropic/claude-sonnet-4-5",
	});
}

describe("subagent stream aggregation", () => {
	test("starts in a running state without a success exit code", () => {
		const result = createResult();

		assert.equal(result.status, "running");
		assert.equal(result.exitCode, null);

		finalizeSingleResult(result, 0);

		assert.equal(result.status, "completed");
		assert.equal(result.exitCode, 0);
	});

	test("shows a tool-call preview before any text or tool output exists", () => {
		const result = createResult();
		applyChildEvent(result, {
			type: "message_end",
			message: createAssistantMessage([createToolCall("bash", { command: "ls -la" })], { stopReason: "toolUse" }),
		});

		assert.equal(getBestAvailableContent(result), "$ ls -la");
	});

	test("captures partial assistant text from message_update", () => {
		const result = createResult();
		applyChildEvent(result, {
			type: "message_update",
			message: createAssistantMessage([{ type: "text", text: "Inspecting files..." }]),
			assistantMessageEvent: { type: "text_delta", delta: "Inspecting files..." },
		});

		assert.equal(getBestAvailableContent(result), "Inspecting files...");
	});

	test("prefers partial tool output over a tool-call preview", () => {
		const result = createResult();
		applyChildEvent(result, {
			type: "message_end",
			message: createAssistantMessage([createToolCall("bash", { command: "ls -la" })], { stopReason: "toolUse" }),
		});
		applyChildEvent(result, {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls -la" },
			partialResult: {
				content: [{ type: "text", text: "package.json\n" }],
				details: {},
			},
		});

		assert.equal(getBestAvailableContent(result), "package.json\n");
	});

	test("prefers final tool output over partial tool output before the final assistant summary", () => {
		const result = createResult();
		applyChildEvent(result, {
			type: "message_end",
			message: createAssistantMessage([createToolCall("bash", { command: "ls -la" })], { stopReason: "toolUse" }),
		});
		applyChildEvent(result, {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls -la" },
			partialResult: {
				content: [{ type: "text", text: "package.json\n" }],
				details: {},
			},
		});
		applyChildEvent(result, {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "package.json\nREADME.md\n" }],
				details: {},
			},
			isError: false,
		});

		assert.equal(getBestAvailableContent(result), "package.json\nREADME.md\n");
	});

	test("captures final tool results delivered as message_end toolResult messages", () => {
		const result = createResult();
		applyChildEvent(result, {
			type: "message_end",
			message: createToolResultMessage("package.json\nREADME.md\n"),
		});

		assert.equal(getBestAvailableContent(result), "package.json\nREADME.md\n");
	});

	test("prefers the final assistant summary over tool output", () => {
		const result = createResult();
		applyChildEvent(result, {
			type: "message_end",
			message: createToolResultMessage("package.json\nREADME.md\n"),
		});
		applyChildEvent(result, {
			type: "message_end",
			message: createAssistantMessage([{ type: "text", text: "Repository listing complete." }]),
		});

		assert.equal(getBestAvailableContent(result), "Repository listing complete.");
	});

	test("exposes live tool output and final tool results through display items", () => {
		const result = createResult();
		applyChildEvent(result, {
			type: "message_end",
			message: createAssistantMessage([createToolCall("bash", { command: "ls -la" })], { stopReason: "toolUse" }),
		});
		applyChildEvent(result, {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls -la" },
			partialResult: {
				content: [{ type: "text", text: "package.json\n" }],
				details: {},
			},
		});
		assert.deepEqual(getDisplayItems(result), [
			{ type: "toolCall", name: "bash", args: { command: "ls -la" } },
			{ type: "text", text: "package.json\n" },
		]);

		applyChildEvent(result, {
			type: "message_end",
			message: createToolResultMessage("package.json\nREADME.md\n"),
		});

		assert.deepEqual(getDisplayItems(result), [
			{ type: "toolCall", name: "bash", args: { command: "ls -la" } },
			{ type: "text", text: "package.json\nREADME.md\n" },
		]);
	});

	test("streaming display prefers partial tool output over finalized assistant text", () => {
		const result = createResult();
		// Assistant says something then calls bash
		applyChildEvent(result, {
			type: "message_end",
			message: createAssistantMessage([
				{ type: "text", text: "I'll check the date." },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "date" } },
			]),
		});
		// Tool starts streaming
		applyChildEvent(result, {
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "date" },
		});
		applyChildEvent(result, {
			type: "tool_execution_update",
			toolCallId: "call_1",
			toolName: "bash",
			partialResult: { content: [{ type: "text", text: "Tue Apr 7" }] },
		});
		// getBestAvailableContent returns static assistant text (for parent LLM)
		assert.equal(getBestAvailableContent(result), "I'll check the date.");
		// getStreamingDisplayContent returns live tool output (for human display)
		assert.equal(getStreamingDisplayContent(result), "Tue Apr 7");
	});

	test("streaming display falls back to final output when nothing is active", () => {
		const result = createResult();
		applyChildEvent(result, {
			type: "message_end",
			message: createAssistantMessage([{ type: "text", text: "Here is the answer." }]),
		});
		// No active tool — both functions return the same thing
		assert.equal(getBestAvailableContent(result), "Here is the answer.");
		assert.equal(getStreamingDisplayContent(result), "Here is the answer.");
	});

	test("captures session id and cwd from session event", () => {
		const result = createResult();
		const changed = applyChildEvent(result, {
			type: "session",
			id: "abc-123",
			cwd: "/home/user/project",
		});
		assert.equal(changed, false, "session event should not trigger a render");
		assert.equal(result.sessionId, "abc-123");
		assert.equal(result.sessionCwd, "/home/user/project");
	});
});

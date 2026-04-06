/**
 * Shared type definitions for the subagent extension.
 *
 * Domain types live here so the dependency arrow points inward:
 * both the execution engine (index.ts) and the renderer
 * (subagent-render.ts) import from this module.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { AgentScope } from "./agents.js";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ToolExecutionState {
	toolCallId: string;
	toolName: string;
	args: Record<string, any>;
	partialResult?: { content?: Array<{ type: string; text?: string }>; details?: any };
	result?: { content?: Array<{ type: string; text?: string }>; details?: any };
	toolResultMessage?: Message;
	isError?: boolean;
	lastUpdatedAt: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	status: "running" | "completed";
	exitCode: number | null;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	partialAssistantMessage?: Message;
	toolExecutions: ToolExecutionState[];
	streamSequence: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

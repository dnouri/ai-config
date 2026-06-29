/**
 * Loop — repeat a prompt (or template command) indefinitely.
 *
 * /loop /orchestrate my-group   Start looping a template prompt
 * /loop Run tests and fix       Start looping a literal prompt
 * /loop                         Toggle (stop if running, usage if not)
 *
 * Abort (Escape) stops the loop.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";

function getCommandPath(command: { path?: string; sourceInfo?: { path?: string } }): string | undefined {
	return command.sourceInfo?.path ?? command.path;
}

function parseArgs(raw: string): string[] {
	const args: string[] = [];
	let cur = "", quote: string | null = null;
	for (const ch of raw) {
		if (quote) { if (ch === quote) quote = null; else cur += ch; }
		else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === " " || ch === "\t") { if (cur) { args.push(cur); cur = ""; } }
		else cur += ch;
	}
	if (cur) args.push(cur);
	return args;
}

function substituteArgs(content: string, args: string[]): string {
	const all = args.join(" ");
	return content
		.replace(/\$(\d+)/g, (_, n) => args[parseInt(n, 10) - 1] ?? "")
		.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, s, l) => {
			const start = Math.max(parseInt(s, 10) - 1, 0);
			return l ? args.slice(start, start + parseInt(l, 10)).join(" ") : args.slice(start).join(" ");
		})
		.replace(/\$ARGUMENTS/g, all)
		.replace(/\$@/g, all);
}

export default function (pi: ExtensionAPI) {
	let looping = false;
	let iteration = 0;
	let promptText = "";

	function expandPrompt(raw: string): string | null {
		if (!raw.startsWith("/")) return raw;
		const spaceIdx = raw.indexOf(" ");
		const name = spaceIdx === -1 ? raw.slice(1) : raw.slice(1, spaceIdx);
		const argsStr = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1);
		const cmd = pi.getCommands().find((c) => c.name === name && c.source === "prompt" && getCommandPath(c));
		const commandPath = cmd ? getCommandPath(cmd) : undefined;
		if (!commandPath) return null;
		const { body } = parseFrontmatter<Record<string, string>>(readFileSync(commandPath, "utf-8"));
		return substituteArgs(body, parseArgs(argsStr));
	}

	function stop(ctx: ExtensionContext) {
		const n = iteration;
		looping = false;
		iteration = 0;
		promptText = "";
		ctx.ui.setStatus("loop", "");
		ctx.ui.notify(`Loop stopped after ${n} iteration(s).`, "info");
	}

	function rootSessionCanSchedule(ctx: ExtensionContext): boolean {
		// Background sessions may finish without a visible UI. Like notify.ts, only
		// let the user-facing session advance the loop, and only when no follow-up
		// is already queued.
		return ctx.hasUI && !ctx.hasPendingMessages();
	}

	function scheduleNext(ctx: ExtensionContext) {
		if (!rootSessionCanSchedule(ctx)) return;

		iteration++;
		ctx.ui.setStatus("loop", `⟳ loop #${iteration}`);
		ctx.ui.notify(`Loop iteration #${iteration}`, "info");
		pi.sendUserMessage(promptText, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	}

	pi.registerCommand("loop", {
		description: "Repeat a prompt forever (/loop <prompt>). Escape to stop.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (!trimmed) {
				if (looping) stop(ctx); else ctx.ui.notify("Usage: /loop <prompt or /template args>", "info");
				return;
			}
			if (looping) stop(ctx);

			if (trimmed.startsWith("/")) {
				const expanded = expandPrompt(trimmed);
				if (expanded === null) {
					ctx.ui.notify(`Template "${trimmed.split(" ")[0]}" not found.`, "error");
					return;
				}
				promptText = expanded;
			} else {
				promptText = trimmed;
			}

			looping = true;
			iteration = 0;
			scheduleNext(ctx);
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!looping || !ctx.hasUI) return;

		// Abort (Escape) stops the loop
		const last = event.messages[event.messages.length - 1];
		if (last?.role === "assistant" && (last as any).stopReason === "aborted") {
			stop(ctx);
			return;
		}

		scheduleNext(ctx);
	});

	pi.on("session_shutdown", async () => {
		looping = false;
	});
}

/**
 * Loop — repeat a prompt (or template command) indefinitely.
 *
 * /loop /orchestrate my-group   Start looping a template prompt
 * /loop Run tests and fix       Start looping a literal prompt
 * /loop stop                    Stop the loop
 * /loop                         Toggle (stop if running, usage if not)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";

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
		const cmd = pi.getCommands().find((c) => c.name === name && c.source === "prompt" && c.path);
		if (!cmd?.path) return null;
		const { body } = parseFrontmatter<Record<string, string>>(readFileSync(cmd.path, "utf-8"));
		return substituteArgs(body, parseArgs(argsStr));
	}

	function stop(ctx: ExtensionContext) {
		looping = false;
		ctx.ui.setStatus("loop", "");
		ctx.ui.notify(`Loop stopped after ${iteration} iteration(s).`, "info");
		iteration = 0;
		promptText = "";
	}

	function next(ctx: ExtensionContext) {
		iteration++;
		ctx.ui.setStatus("loop", `⟳ loop #${iteration}`);
		ctx.ui.notify(`Loop iteration #${iteration}`, "info");
		pi.sendUserMessage(promptText, { deliverAs: "followUp" });
	}

	pi.registerCommand("loop", {
		description: "Repeat a prompt forever (/loop <prompt>, /loop stop)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed === "stop") {
				if (looping) stop(ctx); else ctx.ui.notify("No loop is running.", "info");
				return;
			}
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
			next(ctx);
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!looping) return;
		next(ctx);
	});

	pi.on("session_shutdown", async () => {
		looping = false;
	});
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function formatElapsed(startedAt: number | undefined): string | undefined {
  if (startedAt === undefined) return undefined;
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function wasAborted(event: { messages: unknown[] }): boolean {
  const lastMessage = event.messages[event.messages.length - 1];
  return (
    typeof lastMessage === "object" &&
    lastMessage !== null &&
    "role" in lastMessage &&
    "stopReason" in lastMessage &&
    lastMessage.role === "assistant" &&
    lastMessage.stopReason === "aborted"
  );
}

export default function (pi: ExtensionAPI) {
  let agentStartedAt: number | undefined;

  pi.on("agent_start", () => {
    agentStartedAt = Date.now();
  });

  pi.on("agent_end", async (event, ctx) => {
    // pi-submarine child sessions run headless; notify only user-facing parent sessions.
    if (!ctx.hasUI || ctx.hasPendingMessages() || wasAborted(event)) {
      return;
    }

    const elapsed = formatElapsed(agentStartedAt);
    const title = `Pi is ready · ${basename(ctx.cwd)}`;
    const body = elapsed ? `${elapsed} · ${ctx.cwd}` : ctx.cwd;

    await pi.exec("bash", [
      "-c",
      `(command -v notify-send >/dev/null 2>&1 && notify-send ${shellQuote(title)} ${shellQuote(body)} -t 5000 || true) && ` +
        `(command -v paplay >/dev/null 2>&1 && paplay /usr/share/sounds/freedesktop/stereo/complete.oga || true)`,
    ]);
  });
}

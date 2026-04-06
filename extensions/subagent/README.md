# Subagent extension

Delegate tasks to specialized subagents with isolated context windows.

Forked from the upstream example at `pi-mono/packages/coding-agent/examples/extensions/subagent`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point — tool registration and execution |
| `subagent-types.ts` | Shared domain types (`SingleResult`, `SubagentDetails`, etc.) |
| `subagent-render.ts` | Rendering for tool calls and results |
| `subagent-stream.js` | Child-event aggregation and display-item extraction |
| `agents.ts` | Agent discovery from user and project directories |
| `subagent-core.js` | Pure helpers for child argv, mode detection, formatting, and agent normalization |
| `subagent-core.test.js` | `node:test` suite for `subagent-core.js` |
| `subagent-stream.test.js` | `node:test` suite for `subagent-stream.js` |

## Deviations from upstream

- **Session persistence**: child processes persist sessions normally (no `--no-session`).
- **Sole-agent default**: when exactly one agent is discovered, omitted `agent` fields resolve to that agent in all three modes; ambiguous omission fails with the available-agent list.
- **Standalone invocation guard**: child spawning detects standalone `pi` executables to avoid injecting Bun-internal paths as bogus prompts.

#!/usr/bin/env bun
/**
 * Minimal `gjc --mode rpc` protocol emulator — a TEST FIXTURE (never shipped).
 *
 * It speaks the real JSONL protocol from docs/rpc.md so the harness e2e exercises the
 * genuine `GajaeCodeRpc` adapter (ready frame, prompt ack + agent_start, get_state) against
 * a real subprocess, without a live model. It does NOT fake acceptance/completion inside
 * shipped code — the control plane drives this exactly as it would drive real gjc.
 */
import { writeFileSync } from "node:fs";

// When asked, record the GJC spawn-provenance marker this RPC child was spawned
// with so the harness detached-owner e2e can prove `#runOwner` injects it.
const envRecordPath = process.env.GJC_FAKE_RPC_ENV_RECORD;
if (envRecordPath) writeFileSync(envRecordPath, process.env.GJC_SPAWNED_BY_SESSION ?? "");
process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let idx = buffer.indexOf("\n");
	while (idx >= 0) {
		const line = buffer.slice(0, idx).trim();
		buffer = buffer.slice(idx + 1);
		if (line) handle(line);
		idx = buffer.indexOf("\n");
	}
});

function handle(line: string): void {
	let frame: { id?: string; type?: string };
	try {
		frame = JSON.parse(line) as { id?: string; type?: string };
	} catch {
		return;
	}
	if (frame.type === "get_state") {
		process.stdout.write(
			`${JSON.stringify({ type: "response", id: frame.id, command: "get_state", success: true, data: { isStreaming: false, queuedMessageCount: 0 } })}\n`,
		);
	} else if (frame.type === "prompt") {
		process.stdout.write(`${JSON.stringify({ type: "response", id: frame.id, command: "prompt", success: true })}\n`);
		// Emit a realistic tool turn so the owner can surface tool-call -> completed.
		// Session events are delivered ONLY as canonical agent-wire `event` frames
		// ({ type:"event", payload:{ event_type, event } }) — the same shape real
		// `gjc --mode rpc` emits and the only shape observeRpcOutboundFrame maps to
		// owner signals (see docs/rpc.md and rpc-mode.ts).
		const w = (event: Record<string, unknown>): void => {
			process.stdout.write(`${JSON.stringify({ type: "event", payload: { event_type: event.type, event } })}\n`);
		};
		w({ type: "agent_start" });
		if (process.env.GJC_FAKE_RPC_STORM === "1") {
			for (let i = 0; i < 200; i++) w({ type: "message_update", messageId: "m1", delta: "noise" });
		}
		w({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo hi" } });
		w({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo hi" },
			partialResult: { status: "running" },
		});
		w({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hi" }], details: { status: "ok" } },
		});
		w({ type: "agent_end" });
	}
}

// Stay alive until the parent closes our stdin / kills us.
setInterval(() => {}, 1 << 30);

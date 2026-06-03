#!/usr/bin/env bun
/**
 * Minimal `gjc --mode rpc` protocol emulator — a TEST FIXTURE (never shipped).
 *
 * It speaks the real JSONL protocol from docs/rpc.md so the harness e2e exercises the
 * genuine `GajaeCodeRpc` adapter (ready frame, prompt ack + agent_start, get_state) against
 * a real subprocess, without a live model. It does NOT fake acceptance/completion inside
 * shipped code — the control plane drives this exactly as it would drive real gjc.
 */
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
		process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
	}
}

// Stay alive until the parent closes our stdin / kills us.
setInterval(() => {}, 1 << 30);

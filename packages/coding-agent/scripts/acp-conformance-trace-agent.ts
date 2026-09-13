import * as fs from "node:fs/promises";
import * as path from "node:path";

const traceRoot = process.env.GJC_RELEASE_TRACE_DIR;
if (!traceRoot) throw new Error("A dedicated conformance trace directory is required");
await fs.mkdir(traceRoot, { recursive: true });
const tracePath = path.join(traceRoot, `wire-${process.pid}.jsonl`);
let writes = Promise.resolve();
function record(value: Record<string, unknown>): void {
	const line = `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`;
	writes = writes.then(async () => {
		await fs.appendFile(tracePath, line);
	});
}
function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function observer(direction: string): (bytes: Uint8Array) => void {
	const decoder = new TextDecoder();
	let pending = "";
	return bytes => {
		pending += decoder.decode(bytes, { stream: true });
		if (pending.length > 1024 * 1024) {
			record({ direction, event: "oversize-frame", length: pending.length });
			pending = "";
			return;
		}
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			try {
				const frame = object(JSON.parse(line));
				const params = object(frame.params);
				const result = object(frame.result);
				const method =
					typeof frame.method === "string" &&
					[
						"initialize",
						"authenticate",
						"session/new",
						"session/prompt",
						"session/cancel",
						"session/update",
					].includes(frame.method)
						? frame.method
						: undefined;
				const sessionId =
					typeof params.sessionId === "string" &&
					/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(params.sessionId)
						? params.sessionId
						: undefined;
				const stopReason =
					typeof result.stopReason === "string" &&
					["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(result.stopReason)
						? result.stopReason
						: undefined;
				const sleep5000 =
					Array.isArray(params.prompt) && params.prompt.some(block => object(block).text === "sleep 5000");
				const update = object(params.update).sessionUpdate;
				const updateKind =
					typeof update === "string" &&
					[
						"agent_message_chunk",
						"user_message_chunk",
						"agent_thought_chunk",
						"tool_call",
						"tool_call_update",
						"available_commands_update",
						"session_info_update",
						"config_option_update",
					].includes(update)
						? update
						: undefined;
				const error = object(frame.error).code;
				record({
					direction,
					id: typeof frame.id === "number" ? frame.id : undefined,
					method,
					sessionId,
					stopReason,
					sleep5000,
					updateKind,
					errorCode: typeof error === "number" ? error : undefined,
				});
			} catch {
				record({ direction, event: "non-json-frame", bytes: line.length });
			}
		}
	};
}
const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "acp-conformance-agent.ts")], {
	env: process.env,
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});
const observeInput = observer("client-to-agent");
const observeOutput = observer("agent-to-client");
void (async () => {
	for await (const bytes of Bun.stdin.stream()) {
		observeInput(bytes);
		child.stdin.write(bytes);
		await child.stdin.flush();
	}
	child.stdin.end();
})().catch(() => record({ event: "input-closed" }));
const output = (async () => {
	for await (const bytes of child.stdout) {
		observeOutput(bytes);
		await Bun.write(Bun.stdout, bytes);
	}
})();
const errors = (async () => {
	for await (const bytes of child.stderr) {
		record({ event: "stderr", bytes: bytes.byteLength });
		await Bun.write(Bun.stderr, bytes);
	}
})();
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.once("SIGINT", () => child.kill("SIGINT"));
const exitCode = await child.exited;
await Promise.all([output, errors]);
record({ event: "exit", exitCode });
await writes;
process.exit(exitCode);

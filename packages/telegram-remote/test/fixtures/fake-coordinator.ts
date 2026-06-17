/**
 * Minimal fake Coordinator MCP stdio server for exercising the real
 * McpStdioCoordinatorClient subprocess + JSON-RPC framing. Mirrors the wire
 * shape of the real coordinator: newline-delimited JSON-RPC, tool results
 * wrapped as `{ content: [{ type: "text", text: JSON.stringify(payload) }] }`.
 */
interface JsonRpcRequest {
	id?: number | string | null;
	method?: string;
	params?: { name?: string; arguments?: Record<string, unknown> };
}

function toolPayload(name: string, args: Record<string, unknown>): Record<string, unknown> {
	switch (name) {
		case "gjc_coordinator_read_coordination_status":
			return {
				ok: true,
				sessions: [{ session_id: "sess-1", branch: "main" }],
				session_states: [
					{ session_id: "sess-1", state: "running", live: true, updated_at: "2026-06-15T00:00:00.000Z" },
				],
				turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1" }],
			};
		case "gjc_coordinator_start_session":
			if (args.allow_mutation !== true) {
				return { ok: false, reason: "coordinator_mutation_call_not_allowed:sessions" };
			}
			return { ok: true, session: { session_id: "sess-new" } };
		case "gjc_coordinator_report_status":
			if (args.allow_mutation !== true) {
				return { ok: false, reason: "coordinator_mutation_call_not_allowed:reports" };
			}
			return { ok: true, report: { status: args.status, turn_id: args.turn_id ?? null } };
		case "gjc_coordinator_watch_events":
			if (
				args.after_seq !== 7 ||
				args.session_id !== "sess-1" ||
				!Array.isArray(args.event_types) ||
				args.event_types[0] !== "turn.completed" ||
				args.timeout_ms !== 30000 ||
				args.limit !== 100
			) {
				return { ok: false, reason: "bad_watch_args", args };
			}
			return {
				ok: true,
				events: [
					{
						seq: 8,
						kind: "turn.completed",
						session_id: "sess-1",
						summary: "HOSTILE SUMMARY MUST NOT ESCAPE",
						metadata: { secret: "HOSTILE METADATA MUST NOT ESCAPE" },
						payload_ref: "HOSTILE_PAYLOAD_REF",
					},
					{ seq: 9, kind: "session.state_changed", session_id: "" },
					{ seq: 10, session_id: "sess-2", summary: "missing kind" },
					{ seq: -1, kind: "turn.failed", session_id: "sess-3" },
				],
				latest_seq: 10,
				timed_out: true,
			};
		default:
			return { ok: false, reason: "unknown_tool", tool: name };
	}
}

function respond(request: JsonRpcRequest): unknown {
	const id = request.id ?? null;
	if (request.method === "initialize") {
		return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: {} } };
	}
	if (request.method === "tools/call") {
		const payload = toolPayload(request.params?.name ?? "", request.params?.arguments ?? {});
		return {
			jsonrpc: "2.0",
			id,
			result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: payload.ok === false },
		};
	}
	return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown_method:${request.method}` } };
}

let buffer = "";
for await (const chunk of process.stdin) {
	buffer += Buffer.from(chunk).toString("utf8");
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line.length > 0) {
			const request = JSON.parse(line) as JsonRpcRequest;
			if (request.id !== undefined && request.id !== null) {
				process.stdout.write(`${JSON.stringify(respond(request))}\n`);
			}
		}
		newline = buffer.indexOf("\n");
	}
}

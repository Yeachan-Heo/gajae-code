import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";

const gate: RpcWorkflowGate = {
	type: "workflow_gate",
	gate_id: "wg_test_ralplan_000001",
	stage: "ralplan",
	kind: "approval",
	schema: { type: "object" },
	schema_hash: "hash-1",
	context: { title: "Approve?" },
	created_at: "2026-06-05T05:00:00.000Z",
	required: true,
};

async function withFakeServer(source: string, run: (client: RpcClient) => Promise<void>): Promise<void> {
	const scriptPath = path.join(os.tmpdir(), `gjc-rpc-workflow-gate-${Date.now()}-${Math.random()}.js`);
	await Bun.write(scriptPath, source);
	const client = new RpcClient({ cliPath: scriptPath });
	try {
		await run(client);
	} finally {
		client.stop();
		await fs.unlink(scriptPath).catch(() => undefined);
	}
}

describe("RpcClient workflow_gate transport", () => {
	it("delivers top-level workflow_gate frames to listeners", async () => {
		await withFakeServer(
			`
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
write(${JSON.stringify(gate)});
setInterval(() => {}, 1000);
`,
			async client => {
				const { promise, resolve } = Promise.withResolvers<RpcWorkflowGate>();
				client.onWorkflowGate(resolve);
				await client.start();
				const received = await promise;
				expect(received.gate_id).toBe(gate.gate_id);
				expect(received.kind).toBe("approval");
			},
		);
	});

	it("surfaces object-valued typed error responses instead of timing out", async () => {
		await withFakeServer(
			`
let buffer = "";
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			const frame = JSON.parse(line);
			write({
				id: frame.id,
				type: "response",
				command: frame.type,
				success: false,
				error: { code: "scope_denied", scope: "prompt" },
			});
		}
		index = buffer.indexOf("\\n");
	}
});
`,
			async client => {
				await client.start();
				await expect(client.respondGate(gate.gate_id, { decision: "approve" }, "idem-1")).rejects.toThrow(
					/"scope_denied"/,
				);
			},
		);
	});

	it("respondGate waits for and returns the gate resolution envelope", async () => {
		await withFakeServer(
			`
let buffer = "";
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			const frame = JSON.parse(line);
			write({
				id: frame.id,
				type: "response",
				command: "workflow_gate_response",
				success: true,
				data: {
					gate_id: frame.gate_id,
					status: "accepted",
					answer_hash: "sha256:answer",
					resolved_at: "2026-06-05T05:01:00.000Z",
				},
			});
		}
		index = buffer.indexOf("\\n");
	}
});
`,
			async client => {
				await client.start();
				const resolution = await client.respondGate(gate.gate_id, { decision: "approve" }, "idem-1");
				expect(resolution).toMatchObject({ gate_id: gate.gate_id, status: "accepted" });
			},
		);
	});

	it("negotiateUnattended sends negotiate_unattended and returns the accepted declaration", async () => {
		await withFakeServer(
			`
let buffer = "";
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			const frame = JSON.parse(line);
			const d = frame.declaration;
			write({
				id: frame.id,
				type: "response",
				command: "negotiate_unattended",
				success: true,
				data: {
					run_id: "run-fake",
					actor: d.actor,
					budget: d.budget,
					scopes: d.scopes,
					action_allowlist: d.action_allowlist,
					accepted_at: "2026-06-05T05:00:00.000Z",
				},
			});
		}
		index = buffer.indexOf("\\n");
	}
});
`,
			async client => {
				await client.start();
				const accepted = await client.negotiateUnattended({
					actor: "hermes",
					budget: { max_tokens: 100, max_tool_calls: 2, max_wall_time_ms: 1000, max_cost_usd: 1 },
					scopes: ["prompt"],
					action_allowlist: ["command.prompt"],
				});
				expect(accepted).toMatchObject({ run_id: "run-fake", actor: "hermes", scopes: ["prompt"] });
			},
		);
	});

	it("onExtensionUiRequest delivers extension_ui_request frames to listeners", async () => {
		await withFakeServer(
			`
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
write({ type: "extension_ui_request", id: "ui-1", method: "select", title: "pick", options: ["a", "b"] });
setInterval(() => {}, 1000);
`,
			async client => {
				const { promise, resolve } = Promise.withResolvers<RpcExtensionUIRequest>();
				client.onExtensionUiRequest(resolve);
				await client.start();
				const req = await promise;
				expect(req.method).toBe("select");
				expect(req.id).toBe("ui-1");
			},
		);
	});
});

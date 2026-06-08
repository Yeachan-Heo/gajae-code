import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest, RpcUnattendedDeclaration } from "@gajae-code/coding-agent/modes/rpc/rpc-types";

const declaration: RpcUnattendedDeclaration = {
	actor: "redteam-agent",
	budget: { max_tokens: 100, max_tool_calls: 2, max_wall_time_ms: 1000, max_cost_usd: 1 },
	scopes: ["prompt", "control"],
	action_allowlist: ["command.prompt", "command.control"],
};

async function withFakeServer(source: string, run: (client: RpcClient) => Promise<void>): Promise<void> {
	const scriptPath = path.join(os.tmpdir(), `gjc-rpc-workflow-gate-redteam-${Date.now()}-${Math.random()}.js`);
	await Bun.write(scriptPath, source);
	const client = new RpcClient({ cliPath: scriptPath });
	try {
		await run(client);
	} finally {
		client.stop();
		await fs.unlink(scriptPath).catch(() => undefined);
	}
}

describe("RpcClient workflow_gate red-team hardening", () => {
	it("negotiateUnattended fail-closes on object-valued refusal responses", async () => {
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
				error: { code: "incomplete_budget" },
			});
		}
		index = buffer.indexOf("\\n");
	}
});
`,
			async client => {
				await client.start();
				await expect(client.negotiateUnattended(declaration)).rejects.toThrow(/"incomplete_budget"/);
			},
		);
	});

	it("onExtensionUiRequest unsubscribe stops further delivery", async () => {
		await withFakeServer(
			`
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
setTimeout(() => write({ type: "extension_ui_request", id: "ui-1", method: "select", title: "pick", options: ["a", "b"] }), 0);
setTimeout(() => write({ type: "extension_ui_request", id: "ui-2", method: "select", title: "pick again", options: ["c", "d"] }), 20);
setInterval(() => {}, 1000);
`,
			async client => {
				const received: RpcExtensionUIRequest[] = [];
				const { promise, resolve } = Promise.withResolvers<void>();
				const unsubscribe = client.onExtensionUiRequest(req => {
					received.push(req);
					unsubscribe();
					resolve();
				});
				await client.start();
				await promise;
				await Bun.sleep(60);
				expect(received.map(req => req.id)).toEqual(["ui-1"]);
			},
		);
	});

	it("negotiateUnattended sends exactly negotiate_unattended and carries the declaration verbatim", async () => {
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
				command: "negotiate_unattended",
				success: true,
				data: {
					run_id: "run-redteam",
					accepted_at: "2026-06-05T05:00:00.000Z",
					echoed_type: frame.type,
					echoed_declaration: frame.declaration,
				},
			});
		}
		index = buffer.indexOf("\\n");
	}
});
`,
			async client => {
				await client.start();
				const accepted = await client.negotiateUnattended(declaration);
				expect(accepted).toMatchObject({ echoed_type: "negotiate_unattended", echoed_declaration: declaration });
			},
		);
	});

	it("onExtensionUiRequest delivers confirm method frames for human-UI assertions", async () => {
		await withFakeServer(
			`
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
write({ type: "extension_ui_request", id: "ui-confirm", method: "confirm", title: "confirm?", message: "danger" });
setInterval(() => {}, 1000);
`,
			async client => {
				const { promise, resolve } = Promise.withResolvers<RpcExtensionUIRequest>();
				client.onExtensionUiRequest(resolve);
				await client.start();
				const req = await promise;
				expect(req.method).toBe("confirm");
				expect(req.id).toBe("ui-confirm");
			},
		);
	});
});

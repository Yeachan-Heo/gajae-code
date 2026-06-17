import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type { RpcCommand } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { approvalGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/approval-gate";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import { UnattendedSessionControlPlane } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-session";
import { FileGateStore } from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

const unattendedDeclaration = {
	actor: "rpc-pending-gates-test",
	budget: { max_tokens: 100_000, max_tool_calls: 10, max_wall_time_ms: 60_000, max_cost_usd: 1 },
	scopes: ["prompt", "control", "message:read"],
	action_allowlist: ["command.prompt", "command.control", "command.message_read"],
};

let workspace: string;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-pending-gates-"));
	await mkdir(path.join(workspace, ".gjc", "state", "workflow-gates"), { recursive: true });
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

describe("pending workflow gates over UDS", () => {
	test("replays a durable pending gate over UDS and resolves duplicate answers idempotently", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const runId = "uds-replay-run";
		const store = new FileGateStore(path.join(workspace, ".gjc", "state", "workflow-gates", `${runId}.json`));
		let currentSocket: import("bun").Socket | undefined;
		const emitted: unknown[] = [];
		const controlPlane = new UnattendedSessionControlPlane({
			runId,
			sessionId: runId,
			store,
			providerSupportsTokenCostMetrics: true,
			emitFrame: gate => {
				emitted.push(gate);
				currentSocket?.write(`${JSON.stringify(gate)}\n`);
			},
		});
		controlPlane.negotiate(unattendedDeclaration);
		void controlPlane.emitGate(
			approvalGate({
				title: "Approve replayed gate",
				plan: "PR1 pending gate replay",
				source: "uds-test",
			}),
		);
		const gate = emitted[0] as { gate_id: string; schema: unknown; context: unknown };
		expect(gate.gate_id).toBeTruthy();

		const context = {
			session: {} as never,
			output: (frame: unknown) => currentSocket?.write(`${JSON.stringify(frame)}\n`),
			hostToolRegistry: {} as never,
			hostUriRegistry: {} as never,
			createUiContext: () => ({ notify: () => {} }),
			unattendedControlPlane: controlPlane,
		} as RpcCommandDispatchContext;
		let buffered = "";
		const server = Bun.listen({
			unix: socketPath,
			socket: {
				open(socket) {
					currentSocket = socket;
					socket.write(`${JSON.stringify({ type: "ready" })}\n`);
				},
				data(socket, data) {
					buffered += new TextDecoder().decode(data);
					let nl = buffered.indexOf("\n");
					while (nl >= 0) {
						const line = buffered.slice(0, nl).trim();
						buffered = buffered.slice(nl + 1);
						if (line) {
							void dispatchRpcCommand(JSON.parse(line) as RpcCommand, context).then(response => {
								socket.write(`${JSON.stringify(response)}\n`);
							});
						}
						nl = buffered.indexOf("\n");
					}
				},
				close(socket) {
					if (socket === currentSocket) currentSocket = undefined;
				},
			},
		});
		try {
			const client = new RpcClient({ transport: "uds", socketPath });
			await client.start();
			const pending = await client.getPendingWorkflowGates();
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({
				gate_id: gate.gate_id,
				stage: "ralplan",
				kind: "approval",
				schema: gate.schema,
				context: gate.context,
			});

			const answer = { decision: "approve" };
			const first = await client.respondGate(gate.gate_id, answer, "idem-approve-1");
			expect(first).toMatchObject({ gate_id: gate.gate_id, status: "accepted" });
			expect(store.get(gate.gate_id)?.advanced).toBe(true);

			const duplicate = await client.respondGate(gate.gate_id, answer, "idem-approve-1");
			expect(duplicate).toEqual(first);
			expect(store.get(gate.gate_id)?.advanced).toBe(true);

			await expect(client.respondGate(gate.gate_id, { decision: "reject" }, "idem-approve-1")).rejects.toThrow(
				/idempotency_conflict/,
			);
			expect(await client.getPendingWorkflowGates()).toEqual([]);
			client.stop();
		} finally {
			currentSocket?.end();
			server.stop(true);
		}
	}, 10_000);
});

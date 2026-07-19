import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GateContinuation } from "../src/modes/shared/agent-wire/workflow-gate-broker";
import {
	FileGateStore,
	type GateAuditEvent,
	isUnsupportedWindowsDirectorySyncError,
	MemoryGateStore,
	WorkflowGateBroker,
	WorkflowGateBrokerError,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import type { WorkflowGate } from "../src/modes/shared/agent-wire/workflow-gate-types";

function liveContinuation(): GateContinuation {
	let live = true;
	return {
		activate: () => {},
		isLive: () => live,
		release: () => {
			live = false;
		},
	};
}

function makeBroker(
	extra: { audit?: (e: GateAuditEvent) => void; advance?: (g: WorkflowGate, a: unknown) => void } = {},
) {
	const emitted: WorkflowGate[] = [];
	const audit: GateAuditEvent[] = [];
	const advanced: Array<{ gate: WorkflowGate; answer: unknown }> = [];
	const broker = new WorkflowGateBroker("2026-06-05-0449-4845", new MemoryGateStore(), {
		emit: g => emitted.push(g),
		terminalizeAccepted: () => "not_published",
		advance: (g, a) => {
			advanced.push({ gate: g, answer: a });
			extra.advance?.(g, a);
		},
		audit: e => {
			audit.push(e);
			extra.audit?.(e);
		},
	});
	return { broker, emitted, audit, advanced };
}

describe("WorkflowGateBroker", () => {
	it("emits run-scoped monotonic gate ids per stage", () => {
		const { broker, emitted } = makeBroker();
		const g1 = broker.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["a", "b"] } },
			liveContinuation(),
		);
		const g2 = broker.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["a", "b"] } },
			liveContinuation(),
		);
		expect(g1.gate_id).toBe("wg_04494845_ralplan_000001");
		expect(g2.gate_id).toBe("wg_04494845_ralplan_000002");
		expect(emitted).toHaveLength(2);
		expect(g1.schema_hash).toBeTruthy();
		expect(g1.required).toBe(true);
	});

	it("rejects reserved/unknown stages", () => {
		const { broker } = makeBroker();
		expect(() => broker.openGate({ stage: "team" as never, kind: "question", schema: { type: "string" } })).toThrow(
			WorkflowGateBrokerError,
		);
	});

	it("accepts a valid answer, persists before advancing exactly once", async () => {
		const { broker, advanced, audit } = makeBroker();
		const gate = broker.openGate(
			{
				stage: "ralplan",
				kind: "approval",
				schema: { type: "string", enum: ["approve"] },
			},
			liveContinuation(),
		);
		const res = await broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		expect(res.status).toBe("accepted");
		expect(advanced).toHaveLength(1);
		expect(audit.some(e => e.event === "gate_response_accepted")).toBe(true);
	});

	it("does not mark an accepted gate terminalized without a terminalization proof", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-no-terminal-proof", new MemoryGateStore(), {
			advance: () => {
				advanced.push(true);
			},
		});
		const gate = broker.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["approve"] } },
			liveContinuation(),
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: "approve" })).rejects.toThrow(
			"no terminalization proof",
		);
		expect(advanced).toEqual([]);
	});

	it("preserves acknowledgement policy updates made before advance", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-ack-policy-"));
		const file = path.join(dir, "gates.json");
		const store = new FileGateStore(file);
		let broker: WorkflowGateBroker;
		broker = new WorkflowGateBroker("run-ack-policy", store, {
			advance: () => {},
			terminalizeAccepted: () => "not_published",
			finalizeAccepted: async record => {
				if (record.ackPolicy?.kind !== "telegram_selected_v1") throw new Error("missing Telegram policy");
				broker.updateAckPolicy(record.gate.gate_id, {
					...record.ackPolicy,
					state: "delivered",
					outcome: { status: "delivered", messageId: 42 },
					updatedAt: "terminal",
				});
			},
		});
		const gate = broker.openGate(
			{ stage: "deep-interview", kind: "question", schema: { type: "string" } },
			liveContinuation(),
		);
		await broker.resolve(
			{ gate_id: gate.gate_id, answer: "yes" },
			{
				semanticDisposition: "commit",
				resolutionOrigin: { kind: "telegram_notification", interactionActionId: "interaction-1" },
				ackPolicy: {
					kind: "telegram_selected_v1",
					commitKey: "commit-1",
					actionId: "interaction-1",
					state: "pending",
					updatedAt: "pending",
				},
			},
		);
		expect(store.get(gate.gate_id)).toMatchObject({
			advanced: true,
			ackPolicy: {
				kind: "telegram_selected_v1",
				state: "delivered",
				outcome: { status: "delivered", messageId: 42 },
			},
		});
		const reopened = new FileGateStore(file).get(gate.gate_id);
		expect(reopened).toMatchObject({
			status: "accepted",
			advanced: true,
			answer: "yes",
			semanticDisposition: "commit",
			resolutionOrigin: { kind: "telegram_notification", interactionActionId: "interaction-1" },
			resolution: { gate_id: gate.gate_id, status: "accepted" },
			ackPolicy: {
				kind: "telegram_selected_v1",
				commitKey: "commit-1",
				actionId: "interaction-1",
				state: "delivered",
				outcome: { status: "delivered", messageId: 42 },
			},
		});
	});

	it("leaves the gate pending on an invalid answer", async () => {
		const { broker, advanced } = makeBroker();
		const gate = broker.openGate(
			{
				stage: "ralplan",
				kind: "approval",
				schema: { type: "string", enum: ["approve"] },
			},
			liveContinuation(),
		);
		const res = await broker.resolve({ gate_id: gate.gate_id, answer: "nope" });
		expect(res.status).toBe("rejected");
		expect(res.error?.code).toBe("invalid_workflow_gate_answer");
		expect(advanced).toHaveLength(0);
		// Gate still pending → a subsequent valid answer is accepted.
		const ok = await broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		expect(ok.status).toBe("accepted");
	});

	it("is idempotent on replay and detects conflicts", async () => {
		const { broker, advanced } = makeBroker();
		const gate = broker.openGate(
			{ stage: "ultragoal", kind: "execution", schema: { type: "boolean" } },
			liveContinuation(),
		);
		const first = await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "k1" });
		const replay = await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "k1" });
		expect(replay).toEqual(first);
		expect(advanced).toHaveLength(1); // exactly once
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: false, idempotency_key: "k1" })).rejects.toThrow(
			/idempotency_conflict|conflict/,
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toThrow(
			/already_resolved|resolved/,
		);
	});

	it("C07 replays only the completed identical resolution and rejects conflicting or double answers", async () => {
		const { broker, advanced } = makeBroker();
		const gate = broker.openGate(
			{ stage: "ultragoal", kind: "execution", schema: { type: "boolean" } },
			liveContinuation(),
		);
		const first = await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "c07" });
		expect(first).toMatchObject({ status: "accepted", gate_id: gate.gate_id });
		expect(advanced).toEqual([{ gate, answer: true }]);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: false, idempotency_key: "c07" })).rejects.toThrow(
			/idempotency_conflict|conflict/,
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toThrow(
			/already_resolved|resolved/,
		);
		expect(await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "c07" })).toEqual(first);
		expect(advanced).toHaveLength(1);
	});

	it("throws on unknown gate ids", async () => {
		const { broker } = makeBroker();
		await expect(broker.resolve({ gate_id: "wg_x_ralplan_000099", answer: 1 })).rejects.toThrow(
			WorkflowGateBrokerError,
		);
	});

	it("quarantines prior-process pending gates so they cannot be answered", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-store-"));
		const file = path.join(dir, "gates.json");
		const b1 = new WorkflowGateBroker("run-xyz", new FileGateStore(file));
		const gate = b1.openGate(
			{ stage: "deep-interview", kind: "question", schema: { type: "string" } },
			liveContinuation(),
		);
		const b2 = new WorkflowGateBroker("run-xyz", new FileGateStore(file));
		expect(b2.listPendingGates()).toEqual([]);
		expect(b2.listGateDiagnostics()).toMatchObject([
			{
				gate_id: gate.gate_id,
				id: `diagnostic:${gate.gate_id}`,
				tag: "quarantined",
				lifecycle: { reason: "orphaned_after_process_restart" },
			},
		]);
		await expect(b2.resolve({ gate_id: gate.gate_id, answer: "an answer" })).rejects.toThrow(/no live pending gate/);
	});

	it("projects durable Q12 metadata and links a reminted gate after persistence", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-query-"));
		const file = path.join(dir, "gates.json");
		const first = new WorkflowGateBroker("run-query", new FileGateStore(file), { advance: () => {} });
		const stale = first.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string" } },
			liveContinuation(),
		);
		const restarted = new WorkflowGateBroker("run-query", new FileGateStore(file), { advance: () => {} });
		const reminted = restarted.openGate(
			{
				stage: "ralplan",
				kind: "approval",
				schema: { type: "string" },
				supersedesGateId: stale.gate_id,
			},
			liveContinuation(),
		);
		expect(restarted.listWorkflowGateQueryRecords()).toMatchObject([
			{ gate_id: reminted.gate_id, id: `pending:${reminted.gate_id}`, tag: "pending" },
			{
				gate_id: stale.gate_id,
				id: `diagnostic:${stale.gate_id}`,
				tag: "quarantined",
				lifecycle: {
					state: "quarantined",
					reason: "orphaned_after_process_restart",
					supersededByGateId: reminted.gate_id,
				},
			},
		]);
	});

	it("serializes live resolution with recovery so advance runs after finalization exactly once", async () => {
		const store = new MemoryGateStore();
		const finalizationStarted = Promise.withResolvers<void>();
		const releaseFinalization = Promise.withResolvers<void>();
		let advances = 0;
		const broker = new WorkflowGateBroker("run-concurrent-recovery", store, {
			terminalizeAccepted: () => "not_published",
			finalizeAccepted: async () => {
				finalizationStarted.resolve();
				await releaseFinalization.promise;
			},
			advance: () => {
				advances++;
			},
		});
		const gate = broker.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string" } },
			liveContinuation(),
		);
		const resolving = broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		await finalizationStarted.promise;
		const recovering = broker.recover();
		await Promise.resolve();
		expect(advances).toBe(0);
		releaseFinalization.resolve();
		await expect(resolving).resolves.toMatchObject({ status: "accepted" });
		await expect(recovering).resolves.toEqual([]);
		expect(advances).toBe(1);
	});

	it("quarantines an accepted-unadvanced gate at the process boundary without replaying it", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-recover-"));
		const file = path.join(dir, "gates.json");
		const b1 = new WorkflowGateBroker("run-rec", new FileGateStore(file), {
			terminalizeAccepted: () => "not_published",
			advance: () => {
				throw new Error("simulated crash during advance");
			},
		});
		const gate = b1.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["go"] } },
			liveContinuation(),
		);
		await expect(b1.resolve({ gate_id: gate.gate_id, answer: "go" })).rejects.toThrow(/crash/);

		let advances = 0;
		const b2 = new WorkflowGateBroker("run-rec", new FileGateStore(file), {
			advance: () => {
				advances++;
			},
		});
		expect(await b2.recover()).toEqual([]);
		expect(advances).toBe(0);
		expect(b2.listGateDiagnostics()).toMatchObject([
			{ gate_id: gate.gate_id, lifecycle: { reason: "accepted_unadvanced_after_process_restart" } },
		]);
	});

	it("retains a same-process accepted advance failure for idempotent recovery", async () => {
		const store = new MemoryGateStore();
		let failAdvance = true;
		let advances = 0;
		const broker = new WorkflowGateBroker("run-live-recovery", store, {
			terminalizeAccepted: () => "not_published",
			advance: () => {
				advances++;
				if (failAdvance) throw new Error("temporary advance failure");
			},
		});
		const gate = broker.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["go"] } },
			liveContinuation(),
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: "go", idempotency_key: "retry" })).rejects.toThrow(
			"temporary advance failure",
		);
		expect(store.get(gate.gate_id)).toMatchObject({ status: "accepted", advanced: false, answer: "go" });
		expect(await broker.resolve({ gate_id: gate.gate_id, answer: "go", idempotency_key: "retry" })).toMatchObject({
			status: "accepted",
		});
		failAdvance = false;
		expect(await broker.recover()).toEqual([gate.gate_id]);
		expect(advances).toBe(2);
		expect(store.get(gate.gate_id)).toMatchObject({ status: "accepted", advanced: true });
	});

	it("fails closed on a malformed but valid FileGateStore document before exposure", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-invalid-document-"));
		const file = path.join(dir, "gates.json");
		const first = new WorkflowGateBroker("run-invalid-document", new FileGateStore(file), { advance: () => {} });
		const gate = first.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string" } },
			liveContinuation(),
		);
		const document = JSON.parse(readFileSync(file, "utf8")) as { gates: Record<string, { advanced: boolean }> };
		document.gates[gate.gate_id]!.advanced = true;
		writeFileSync(file, JSON.stringify(document));
		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
	});

	it("keeps ownerless gates diagnostic-only rather than fabricating hook ownership", async () => {
		const noHook = new WorkflowGateBroker("run-no-hook", new MemoryGateStore());
		const noHookGate = noHook.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		expect(noHook.listPendingGates()).toEqual([]);
		await expect(noHook.resolve({ gate_id: noHookGate.gate_id, answer: "approve" })).rejects.toThrow(
			/no live pending gate/,
		);
		expect(noHook.listGateDiagnostics()).toMatchObject([
			{ gate_id: noHookGate.gate_id, lifecycle: { reason: "opened_without_continuation" } },
		]);

		const { broker } = makeBroker();
		const gate = broker.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string" } },
			liveContinuation(),
		);
		broker.loseContinuation(gate.gate_id);
		expect(broker.listPendingGates()).toEqual([]);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: "approve" })).rejects.toThrow(
			/no live pending gate/,
		);
	});

	it("classifies only unsupported Windows directory sync errors", () => {
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EPERM" }, "win32")).toBe(true);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EINVAL" }, "win32")).toBe(true);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EACCES" }, "win32")).toBe(false);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EPERM" }, "darwin")).toBe(false);
	});

	it("fails closed on a corrupt FileGateStore instead of silently resetting", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-"));
		const file = path.join(dir, "gates.json");
		writeFileSync(file, "{ not valid json");
		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
	});

	it("fails closed when the startup quarantine directory fsync fails", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-fsync-"));
		const file = path.join(dir, "gates.json");
		const first = new WorkflowGateBroker("run-fsync", new FileGateStore(file));
		first.openGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } }, liveContinuation());
		let syncs = 0;
		expect(
			() =>
				new WorkflowGateBroker(
					"run-fsync",
					new FileGateStore(file, () => {
						syncs++;
						if (syncs === 2) throw new Error("directory fsync failed");
					}),
				),
		).toThrow(/directory fsync failed/);
	});
	it("quarantines a disk-accepted record after post-rename fsync uncertainty instead of reissuing it", async () => {
		const file = path.join(mkdtempSync(path.join(tmpdir(), "gate-uncertain-accepted-")), "gates.json");
		let syncs = 0;
		const store = new FileGateStore(file, () => {
			syncs++;
			if (syncs === 8) throw new Error("parent fsync failed after accepted rename");
		});
		const broker = new WorkflowGateBroker("run-uncertain-accepted", store, { advance: () => {} });
		const gate = broker.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["approve"] } },
			liveContinuation(),
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: "approve" })).rejects.toMatchObject({
			certainty: "uncertain",
		});
		expect(broker.listPendingGates()).toEqual([]);
		expect(new FileGateStore(file).get(gate.gate_id)).toMatchObject({
			status: "quarantined",
			lifecycle: { reason: "continuation_owner_lost" },
		});
	});
});

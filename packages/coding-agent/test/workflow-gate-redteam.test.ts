import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GateContinuation } from "../src/modes/shared/agent-wire/workflow-gate-broker";
import {
	FileGateStore,
	type GateAuditEvent,
	GateStoreWriteError,
	MemoryGateStore,
	WorkflowGateBroker,
	WorkflowGateBrokerError,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import {
	answerHashOf,
	assertSupportedGateSchema,
	compileGateSchema,
	GATE_SCHEMA_LIMITS,
	schemaHash,
	validateGateAnswer,
	WorkflowGateSchemaError,
} from "../src/modes/shared/agent-wire/workflow-gate-schema";
import type { JsonSchema, WorkflowGate } from "../src/modes/shared/agent-wire/workflow-gate-types";

function liveContinuation(): GateContinuation {
	let live = true;
	return {
		activate: () => {},
		isLive: () => live,
		terminalProof: "not_published",
		release: () => {
			live = false;
		},
	};
}

function makeBroker() {
	const audit: GateAuditEvent[] = [];
	const advanced: Array<{ gate: WorkflowGate; answer: unknown }> = [];
	const broker = new WorkflowGateBroker("redteam-run-20260605", new MemoryGateStore(), {
		advance: (gate, answer) => {
			advanced.push({ gate, answer });
		},
		audit: event => audit.push(event),
	});
	return { broker, audit, advanced };
}

describe("FileGateStore authority red-team contract", () => {
	it("fails closed before presenting a valid-JSON document with stale authority", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "workflow-gate-stale-authority-"));
		const file = path.join(dir, "gates.json");
		const first = new WorkflowGateBroker("redteam-stale-authority", new FileGateStore(file), { advance: () => {} });
		const gate = first.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string" } },
			liveContinuation(),
		);
		const document = JSON.parse(readFileSync(file, "utf8")) as {
			gates: Record<string, { ownerInstanceId?: string }>;
		};
		delete document.gates[gate.gate_id]!.ownerInstanceId;
		writeFileSync(file, JSON.stringify(document));

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
	});

	it("rejects malformed persisted quarantined lifecycles before Q12 diagnostics can be projected", () => {
		const cases: Array<{
			name: string;
			mutate: (
				document: { gates: Record<string, { lifecycle: Record<string, unknown>; [key: string]: unknown }> },
				gateId: string,
			) => void;
		}> = [
			{
				name: "a non-quarantined lifecycle state",
				mutate: (document, gateId) => {
					document.gates[gateId]!.lifecycle.state = "accepted";
				},
			},
			{
				name: "an unknown lifecycle field",
				mutate: (document, gateId) => {
					document.gates[gateId]!.lifecycle.answer = "malformed";
				},
			},
			{
				name: "an incompatible accepted-state field",
				mutate: (document, gateId) => {
					document.gates[gateId]!.answer = "malformed";
				},
			},
			{
				name: "an empty superseding gate id",
				mutate: (document, gateId) => {
					document.gates[gateId]!.lifecycle.supersededByGateId = "";
				},
			},
			{
				name: "a superseding gate id with no persisted replacement",
				mutate: (document, gateId) => {
					document.gates[gateId]!.lifecycle.supersededByGateId = `${gateId}-replacement`;
				},
			},
		];

		for (const testCase of cases) {
			const dir = mkdtempSync(path.join(tmpdir(), "workflow-gate-malformed-lifecycle-"));
			const file = path.join(dir, "gates.json");
			const broker = new WorkflowGateBroker("redteam-malformed-lifecycle", new FileGateStore(file));
			const gate = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
			const document = JSON.parse(readFileSync(file, "utf8")) as {
				gates: Record<string, { lifecycle: Record<string, unknown>; [key: string]: unknown }>;
			};
			testCase.mutate(document, gate.gate_id);
			writeFileSync(file, JSON.stringify(document));

			expect(() => new FileGateStore(file), testCase.name).toThrow(/corrupt gate store/);
		}
	});

	it("keeps ownerless opened gates diagnostic-only and unanswerable", async () => {
		const broker = new WorkflowGateBroker("redteam-no-continuation", new MemoryGateStore());
		const gate = broker.openGate({ stage: "ultragoal", kind: "execution", schema: { type: "boolean" } });
		expect(broker.listPendingGates()).toEqual([]);
		expect(broker.listWorkflowGateQueryRecords()).toMatchObject([
			{ gate_id: gate.gate_id, tag: "quarantined", lifecycle: { reason: "opened_without_continuation" } },
		]);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toMatchObject({
			code: "unknown_gate",
		});
	});

	it("migrates realistic legacy v0 records before exposing or quarantining them", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "workflow-gate-v0-"));
		const file = path.join(dir, "gates.json");
		const createdAt = "2026-06-05T00:00:00.000Z";
		const gate = {
			type: "workflow_gate",
			gate_id: "wg_legacy_ralplan_000001",
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string" },
			schema_hash: schemaHash({ type: "string" }),
			context: {},
			created_at: createdAt,
			required: true,
		};
		// v0 persisted lifecycle fields but had no version or owner instance.
		writeFileSync(
			file,
			JSON.stringify({
				counters: { ralplan: 1 },
				gates: { [gate.gate_id]: { gate, status: "pending", advanced: false } },
			}),
		);

		const migrated = new FileGateStore(file);
		expect(migrated.get(gate.gate_id)).toMatchObject({
			status: "quarantined",
			ownerInstanceId: "legacy-v0",
			advanced: false,
			lifecycle: { reason: "orphaned_after_process_restart" },
		});
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
		const broker = new WorkflowGateBroker("redteam-v0", migrated);
		expect(broker.listPendingGates()).toEqual([]);
		expect(broker.listGateDiagnostics()).toMatchObject([
			{ gate_id: gate.gate_id, lifecycle: { reason: "orphaned_after_process_restart" } },
		]);
	});

	it("migrates a complete legacy accepted-unadvanced crash record to a Q12 diagnostic", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "workflow-gate-v0-accepted-"));
		const file = path.join(dir, "gates.json");
		const createdAt = "2026-06-05T00:00:00.000Z";
		const schema: JsonSchema = {
			type: "object",
			required: ["approved"],
			properties: { approved: { type: "boolean" } },
		};
		const gate = {
			type: "workflow_gate",
			gate_id: "wg_legacy_ralplan_000001",
			stage: "ralplan",
			kind: "approval",
			schema,
			schema_hash: schemaHash(schema),
			context: {},
			created_at: createdAt,
			required: true,
		};
		const answer = { approved: true };
		writeFileSync(
			file,
			JSON.stringify({
				counters: { ralplan: 1 },
				gates: {
					[gate.gate_id]: {
						gate,
						status: "accepted",
						advanced: false,
						idempotencyKey: "legacy-idempotency-key",
						responseHash: answerHashOf({ gate_id: gate.gate_id, answer }),
						answer,
						resolution: {
							gate_id: gate.gate_id,
							status: "accepted",
							answer_hash: answerHashOf(answer),
							resolved_at: createdAt,
						},
						semanticDisposition: "commit",
						resolutionOrigin: { kind: "generic", channel: "rpc" },
						ackPolicy: { kind: "none", reason: "non_telegram" },
					},
				},
			}),
		);

		const migrated = new FileGateStore(file);
		expect(migrated.get(gate.gate_id)).toMatchObject({
			status: "quarantined",
			ownerInstanceId: "legacy-v0",
			advanced: false,
			answer,
			responseHash: answerHashOf({ gate_id: gate.gate_id, answer }),
			resolution: { gate_id: gate.gate_id, status: "accepted", answer_hash: answerHashOf(answer) },
			idempotencyKey: "legacy-idempotency-key",
			semanticDisposition: "commit",
			resolutionOrigin: { kind: "generic", channel: "sdk" },
			ackPolicy: { kind: "none", reason: "non_telegram" },
			lifecycle: { reason: "accepted_unadvanced_after_process_restart" },
		});
		const broker = new WorkflowGateBroker("redteam-v0-accepted", migrated);
		expect(broker.listGateDiagnostics()).toMatchObject([
			{ gate_id: gate.gate_id, lifecycle: { reason: "accepted_unadvanced_after_process_restart" } },
		]);
	});

	it("fails closed for a legacy accepted-unadvanced record missing its response hash", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "workflow-gate-v0-accepted-malformed-"));
		const file = path.join(dir, "gates.json");
		const createdAt = "2026-06-05T00:00:00.000Z";
		const gate = {
			type: "workflow_gate",
			gate_id: "wg_legacy_ralplan_000001",
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string" },
			schema_hash: schemaHash({ type: "string" }),
			context: {},
			created_at: createdAt,
			required: true,
		};
		writeFileSync(
			file,
			JSON.stringify({
				counters: { ralplan: 1 },
				gates: {
					[gate.gate_id]: {
						gate,
						status: "accepted",
						advanced: false,
						answer: "yes",
						resolution: {
							gate_id: gate.gate_id,
							status: "accepted",
							answer_hash: answerHashOf("yes"),
							resolved_at: createdAt,
						},
					},
				},
			}),
		);

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
	});

	it("keeps a valid accepted-unadvanced restart quarantine loadable", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "workflow-gate-accepted-restart-"));
		const file = path.join(dir, "gates.json");
		const first = new WorkflowGateBroker("redteam-accepted-restart", new FileGateStore(file), {
			advance: () => {
				throw new Error("advance interrupted");
			},
		});
		const gate = first.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["yes"] } },
			liveContinuation(),
		);
		await expect(first.resolve({ gate_id: gate.gate_id, answer: "yes" })).rejects.toThrow("advance interrupted");

		new WorkflowGateBroker("redteam-accepted-restart", new FileGateStore(file));
		const reloaded = new WorkflowGateBroker("redteam-accepted-restart", new FileGateStore(file));
		expect(reloaded.listGateDiagnostics()).toMatchObject([
			{ gate_id: gate.gate_id, lifecycle: { reason: "accepted_unadvanced_after_process_restart" } },
		]);
	});

	it("rolls back failed file mutations and classifies post-rename fsync uncertainty", () => {
		let syncs = 0;
		const store = new FileGateStore(
			path.join(mkdtempSync(path.join(tmpdir(), "workflow-gate-rollback-")), "gates.json"),
			() => {
				syncs++;
				if (syncs === 2) throw new Error("parent fsync failed");
			},
		);
		let failure: unknown;
		try {
			store.nextSeq("ralplan");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(GateStoreWriteError);
		expect(failure).toMatchObject({ certainty: "uncertain" });
		expect(store.nextSeq("ralplan")).toBe(2);
	});
});
function nestedObjectSchema(depth: number): JsonSchema {
	let schema: JsonSchema = { type: "string" };
	for (let i = 0; i < depth; i++) {
		schema = { type: "object", properties: { child: schema }, required: ["child"] };
	}
	return schema;
}

describe("workflow gate red-team contract", () => {
	it("rejects schemas nested beyond the advertised max depth at construction", () => {
		const tooDeep = nestedObjectSchema(GATE_SCHEMA_LIMITS.maxDepth + 1);

		expect(() => assertSupportedGateSchema(tooDeep)).toThrow(WorkflowGateSchemaError);
		expect(() => compileGateSchema(tooDeep)).toThrow(/depth/);
		expect(() => makeBroker().broker.openGate({ stage: "ralplan", kind: "question", schema: tooDeep })).toThrow(
			WorkflowGateSchemaError,
		);
	});

	it("rejects an oversized answer with a typed validation error and leaves the gate pending", async () => {
		const { broker, advanced } = makeBroker();
		const gate = broker.openGate(
			{ stage: "ralplan", kind: "question", schema: { type: "string" } },
			liveContinuation(),
		);
		const oversized = "x".repeat(GATE_SCHEMA_LIMITS.maxAnswerBytes + 1);

		const rejected = await broker.resolve({ gate_id: gate.gate_id, answer: oversized });
		expect(rejected.status).toBe("rejected");
		expect(rejected.error?.code).toBe("invalid_workflow_gate_answer");
		expect(rejected.error?.gate_id).toBe(gate.gate_id);
		expect(rejected.error?.errors[0]?.keyword).toBe("maxAnswerBytes");
		expect(advanced).toHaveLength(0);

		const accepted = await broker.resolve({ gate_id: gate.gate_id, answer: "small enough" });
		expect(accepted.status).toBe("accepted");
		expect(advanced).toHaveLength(1);
	});

	it("enforces oneOf exactly-one semantics when two branches match", () => {
		const compiled = compileGateSchema({
			oneOf: [
				{ type: "number", minimum: 0 },
				{ type: "number", maximum: 10 },
			],
		});

		expect(validateGateAnswer(compiled, "gate-oneof", 11)).toBeNull();
		const error = validateGateAnswer(compiled, "gate-oneof", 5);
		expect(error?.code).toBe("invalid_workflow_gate_answer");
		expect(error?.errors.some(e => e.keyword === "oneOf")).toBe(true);
	});

	it("validates additionalProperties sub-schema values instead of merely allowing extras", () => {
		const compiled = compileGateSchema({
			type: "object",
			properties: { known: { type: "string" } },
			additionalProperties: { type: "integer", minimum: 1 },
		});

		expect(validateGateAnswer(compiled, "gate-additional", { known: "ok", extra: 1 })).toBeNull();
		expect(validateGateAnswer(compiled, "gate-additional", { known: "ok", extra: 0 })?.errors[0]).toMatchObject({
			path: "#/extra",
			keyword: "minimum",
		});
		expect(validateGateAnswer(compiled, "gate-additional", { known: "ok", extra: "1" })?.errors[0]).toMatchObject({
			path: "#/extra",
			keyword: "type",
		});
	});

	it("replays the same idempotency key/body exactly once and rejects same-key different-body conflicts", async () => {
		const { broker, advanced, audit } = makeBroker();
		const gate = broker.openGate(
			{ stage: "ultragoal", kind: "execution", schema: { type: "object" } },
			liveContinuation(),
		);
		const answer = { accepted: true };

		const first = await broker.resolve({ gate_id: gate.gate_id, answer, idempotency_key: "idem-1" });
		const replay = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { accepted: true },
			idempotency_key: "idem-1",
		});
		expect(replay).toEqual(first);
		expect(advanced).toHaveLength(1);
		expect(audit.filter(e => e.event === "gate_response_idempotent_replay")).toHaveLength(1);

		await expect(
			broker.resolve({ gate_id: gate.gate_id, answer: { accepted: false }, idempotency_key: "idem-1" }),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		expect(advanced).toHaveLength(1);
	});

	it("accepts a later valid answer after an earlier invalid answer rejected the same pending gate", async () => {
		const { broker, advanced, audit } = makeBroker();
		const gate = broker.openGate(
			{
				stage: "deep-interview",
				kind: "question",
				schema: { type: "object", required: ["decision"], properties: { decision: { const: "proceed" } } },
			},
			liveContinuation(),
		);

		const rejected = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "stall" } });
		expect(rejected.status).toBe("rejected");
		expect(advanced).toHaveLength(0);

		const accepted = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "proceed" } });
		expect(accepted.status).toBe("accepted");
		expect(advanced).toHaveLength(1);
		expect(audit.map(e => e.event)).toContain("gate_response_rejected");
		expect(audit.map(e => e.event)).toContain("gate_response_accepted");
	});

	it("quarantines fresh-process gates and requires a remint", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "workflow-gate-redteam-"));
		const file = path.join(dir, "gates.json");
		const first = new WorkflowGateBroker("redteam-file-run", new FileGateStore(file));
		const stale = first.openGate(
			{ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["yes"] } },
			liveContinuation(),
		);

		const restarted = new WorkflowGateBroker("redteam-file-run", new FileGateStore(file));
		expect(restarted.listPendingGates()).toEqual([]);
		expect(restarted.listGateDiagnostics()).toMatchObject([
			{
				gate_id: stale.gate_id,
				id: `diagnostic:${stale.gate_id}`,
				tag: "quarantined",
				lifecycle: { state: "quarantined", reason: "orphaned_after_process_restart" },
			},
		]);
		expect(restarted.listWorkflowGateQueryRecords()).toMatchObject([
			{ gate_id: stale.gate_id, id: `diagnostic:${stale.gate_id}`, tag: "quarantined" },
		]);
		await expect(
			restarted.resolve({ gate_id: stale.gate_id, answer: "yes", idempotency_key: "file-idem" }),
		).rejects.toThrow(/no live pending gate/);

		const reminted = restarted.openGate(
			{
				stage: "ralplan",
				kind: "approval",
				schema: { type: "string", enum: ["yes"] },
				supersedesGateId: stale.gate_id,
			},
			liveContinuation(),
		);
		expect(reminted.gate_id).not.toBe(stale.gate_id);
		expect(restarted.listGateDiagnostics()).toMatchObject([
			{ gate_id: stale.gate_id, lifecycle: { supersededByGateId: reminted.gate_id } },
		]);
		const reloaded = new WorkflowGateBroker("redteam-file-run", new FileGateStore(file));
		expect(reloaded.listGateDiagnostics().find(record => record.gate_id === stale.gate_id)).toMatchObject({
			gate_id: stale.gate_id,
			lifecycle: { supersededByGateId: reminted.gate_id },
		});
	});

	it("handles const, enum, and numeric minimum/maximum boundary off-by-one cases", () => {
		const objectConst = { mode: "exact", nested: { count: 2 } };
		const compiled = compileGateSchema({
			type: "object",
			properties: {
				marker: { const: objectConst },
				choice: { type: "string", enum: ["low", "high"] },
				count: { type: "integer", minimum: 2, maximum: 4 },
			},
			required: ["marker", "choice", "count"],
			additionalProperties: false,
		});

		expect(
			validateGateAnswer(compiled, "gate-boundary", { marker: objectConst, choice: "low", count: 2 }),
		).toBeNull();
		expect(
			validateGateAnswer(compiled, "gate-boundary", { marker: objectConst, choice: "high", count: 4 }),
		).toBeNull();
		expect(
			validateGateAnswer(compiled, "gate-boundary", { marker: objectConst, choice: "low", count: 1 })?.errors.some(
				e => e.keyword === "minimum",
			),
		).toBe(true);
		expect(
			validateGateAnswer(compiled, "gate-boundary", { marker: objectConst, choice: "low", count: 5 })?.errors.some(
				e => e.keyword === "maximum",
			),
		).toBe(true);
		expect(
			validateGateAnswer(compiled, "gate-boundary", {
				marker: objectConst,
				choice: "middle",
				count: 3,
			})?.errors.some(e => e.keyword === "enum"),
		).toBe(true);
		expect(
			validateGateAnswer(compiled, "gate-boundary", {
				marker: { mode: "exact", nested: { count: 3 } },
				choice: "low",
				count: 3,
			})?.errors.some(e => e.keyword === "const"),
		).toBe(true);
	});

	it("throws a typed already_resolved error for same body without replay key after acceptance", async () => {
		const { broker } = makeBroker();
		const gate = broker.openGate(
			{ stage: "ultragoal", kind: "execution", schema: { type: "boolean" } },
			liveContinuation(),
		);
		await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "final-key" });

		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toBeInstanceOf(
			WorkflowGateBrokerError,
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toMatchObject({
			code: "already_resolved",
		});
	});
});

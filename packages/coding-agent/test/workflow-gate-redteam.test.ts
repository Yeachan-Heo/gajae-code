import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RpcJsonSchema, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	FileGateStore,
	type GateAuditEvent,
	MemoryGateStore,
	WorkflowGateBroker,
	WorkflowGateBrokerError,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";
import {
	assertSupportedGateSchema,
	compileGateSchema,
	GATE_SCHEMA_LIMITS,
	validateGateAnswer,
	WorkflowGateSchemaError,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-schema";

function makeBroker() {
	const audit: GateAuditEvent[] = [];
	const advanced: Array<{ gate: RpcWorkflowGate; answer: unknown }> = [];
	const broker = new WorkflowGateBroker("redteam-run-20260605", new MemoryGateStore(), {
		advance: (gate, answer) => {
			advanced.push({ gate, answer });
		},
		audit: event => audit.push(event),
	});
	return { broker, audit, advanced };
}

function nestedObjectSchema(depth: number): RpcJsonSchema {
	let schema: RpcJsonSchema = { type: "string" };
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
		const gate = broker.openGate({ stage: "ralplan", kind: "question", schema: { type: "string" } });
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
		const gate = broker.openGate({ stage: "ultragoal", kind: "execution", schema: { type: "object" } });
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
		const gate = broker.openGate({
			stage: "deep-interview",
			kind: "question",
			schema: { type: "object", required: ["decision"], properties: { decision: { const: "proceed" } } },
		});

		const rejected = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "stall" } });
		expect(rejected.status).toBe("rejected");
		expect(advanced).toHaveLength(0);

		const accepted = await broker.resolve({ gate_id: gate.gate_id, answer: { decision: "proceed" } });
		expect(accepted.status).toBe("accepted");
		expect(advanced).toHaveLength(1);
		expect(audit.map(e => e.event)).toContain("gate_response_rejected");
		expect(audit.map(e => e.event)).toContain("gate_response_accepted");
	});

	it("preserves pending gates and accepted idempotency state across fresh FileGateStore brokers", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "workflow-gate-redteam-"));
		const file = path.join(dir, "gates.json");
		const advanced: unknown[] = [];
		const b1 = new WorkflowGateBroker("redteam-file-run", new FileGateStore(file));
		const gate = b1.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["yes"] } });

		const b2 = new WorkflowGateBroker("redteam-file-run", new FileGateStore(file), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const accepted = await b2.resolve({ gate_id: gate.gate_id, answer: "yes", idempotency_key: "file-idem" });
		expect(accepted.status).toBe("accepted");
		expect(advanced).toEqual(["yes"]);

		const b3 = new WorkflowGateBroker("redteam-file-run", new FileGateStore(file), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const replay = await b3.resolve({ gate_id: gate.gate_id, answer: "yes", idempotency_key: "file-idem" });
		expect(replay).toEqual(accepted);
		expect(advanced).toEqual(["yes"]);
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
		const gate = broker.openGate({ stage: "ultragoal", kind: "execution", schema: { type: "boolean" } });
		await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "final-key" });

		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toBeInstanceOf(
			WorkflowGateBrokerError,
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toMatchObject({
			code: "already_resolved",
		});
	});
});
